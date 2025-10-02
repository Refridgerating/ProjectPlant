/* ProjectPlant ESP32 firmware
 * Wi-Fi Provisioning (BLE + PoP) and MQTT client
 */

#include <stdio.h>
#include <string.h>
#include <inttypes.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

#include "esp_system.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "esp_timer.h"
#include "esp_idf_version.h"

#include "mqtt_client.h"

#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_ble.h"

#include "driver/gpio.h"

#include "sdkconfig.h"

static const char *TAG = "projectplant";

#define MAX_CONNECT_FAILS 5

// Event group bits
static EventGroupHandle_t s_event_group;
static const int WIFI_CONNECTED_BIT = BIT0;
static const int IP_ACQUIRED_BIT    = BIT1;
static const int MQTT_CONNECTED_BIT = BIT2;

// Globals
static esp_mqtt_client_handle_t s_mqtt = NULL;
static bool s_provisioning = false;
static int s_connect_fails = 0;

// Topics and IDs
static char s_device_id[13]; // 6 bytes MAC -> 12 hex + null
static char s_topic_tele[64];
static char s_topic_state[64];
static char s_topic_cmd[64];

// Forward decls
static void start_provisioning(void);
static void stop_provisioning(void);
static void start_wifi(void);
static void enter_reprovision(void);
static void mqtt_start(void);
static void mqtt_stop(void);
static void telemetry_task(void *arg);
static void button_task(void *arg);

// Kconfig wrappers
#ifndef CONFIG_PROJECTPLANT_BUTTON_GPIO
#define CONFIG_PROJECTPLANT_BUTTON_GPIO 0
#endif

#ifndef CONFIG_PROJECTPLANT_LONGPRESS_MS
#define CONFIG_PROJECTPLANT_LONGPRESS_MS 3000
#endif

#ifndef CONFIG_PROJECTPLANT_MQTT_BROKER_URI
#define CONFIG_PROJECTPLANT_MQTT_BROKER_URI "mqtt://test.mosquitto.org"
#endif

#ifndef CONFIG_PROJECTPLANT_TELEMETRY_SEC
#define CONFIG_PROJECTPLANT_TELEMETRY_SEC 30
#endif

#ifndef CONFIG_PROJECTPLANT_PROV_POP
#define CONFIG_PROJECTPLANT_PROV_POP "plantpop"
#endif

static void get_device_id(char *out, size_t len)
{
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    // Uppercase hex without separators
    snprintf(out, len, "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

static void build_topics(void)
{
    snprintf(s_topic_tele, sizeof(s_topic_tele), "plant/%s/tele", s_device_id);
    snprintf(s_topic_state, sizeof(s_topic_state), "plant/%s/state", s_device_id);
    snprintf(s_topic_cmd, sizeof(s_topic_cmd), "plant/%s/cmd", s_device_id);
}

static esp_err_t nvs_get_str_alloc(nvs_handle_t nvs, const char *key, char **out)
{
    size_t len = 0;
    esp_err_t err = nvs_get_str(nvs, key, NULL, &len);
    if (err != ESP_OK) return err;
    char *buf = malloc(len);
    if (!buf) return ESP_ERR_NO_MEM;
    err = nvs_get_str(nvs, key, buf, &len);
    if (err != ESP_OK) {
        free(buf);
        return err;
    }
    *out = buf;
    return ESP_OK;
}

static void get_broker_uri(char *out, size_t out_len)
{
    // Default from Kconfig
    const char *fallback = CONFIG_PROJECTPLANT_MQTT_BROKER_URI;
    strncpy(out, fallback, out_len);
    out[out_len - 1] = '\0';

    nvs_handle_t nvs;
    if (nvs_open("mqtt", NVS_READONLY, &nvs) == ESP_OK) {
        char *uri = NULL;
        if (nvs_get_str_alloc(nvs, "broker_url", &uri) == ESP_OK) {
            strncpy(out, uri, out_len);
            out[out_len - 1] = '\0';
            free(uri);
        }
        nvs_close(nvs);
    }
}

static void save_broker_uri(const char *uri)
{
    nvs_handle_t nvs;
    if (nvs_open("mqtt", NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_set_str(nvs, "broker_url", uri);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
}

static void wifi_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data)
{
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        s_connect_fails++;
        ESP_LOGW(TAG, "Wi-Fi disconnected (fail %d)", s_connect_fails);
        if (!s_provisioning && s_connect_fails >= MAX_CONNECT_FAILS) {
            ESP_LOGW(TAG, "Starting provisioning due to repeated failures");
            enter_reprovision();
            return;
        }
        // Try reconnect
        esp_wifi_connect();
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t* event = (ip_event_got_ip_t*) event_data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_event_group, WIFI_CONNECTED_BIT | IP_ACQUIRED_BIT);
        // Reset fail counter
        s_connect_fails = 0;
        // Start MQTT if not started
        if (s_mqtt == NULL) {
            mqtt_start();
        }
    }
}

static void prov_event_handler(void* arg, esp_event_base_t event_base, int32_t event_id, void* event_data)
{
    if (event_base != WIFI_PROV_EVENT) return;
    switch (event_id) {
    case WIFI_PROV_START:
        ESP_LOGI(TAG, "Provisioning started");
        break;
    case WIFI_PROV_CRED_RECV: {
        wifi_sta_config_t *wifi_sta_cfg = (wifi_sta_config_t *)event_data;
        ESP_LOGI(TAG, "Received Wi-Fi credentials\n\tSSID: %s\n\tPassword: %s", (const char *) wifi_sta_cfg->ssid, (const char *) wifi_sta_cfg->password);
        break; }
    case WIFI_PROV_CRED_SUCCESS:
        ESP_LOGI(TAG, "Provisioning successful");
        break;
    case WIFI_PROV_END:
        ESP_LOGI(TAG, "Provisioning end");
        stop_provisioning();
        start_wifi();
        break;
    default:
        break;
    }
}

static void start_provisioning(void)
{
    if (s_provisioning) return;
    s_provisioning = true;

    wifi_prov_mgr_config_t cfg = {
        .scheme = wifi_prov_scheme_ble,
        .scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM,
    };
    ESP_ERROR_CHECK(wifi_prov_mgr_init(cfg));

    char service_name[16] = {0};
    // Use last 3 bytes for brevity
    snprintf(service_name, sizeof(service_name), "PROV_%s", s_device_id + 6);

    const char *pop = CONFIG_PROJECTPLANT_PROV_POP;
    ESP_LOGI(TAG, "Starting BLE provisioning: service '%s'", service_name);

    wifi_prov_security_t security = WIFI_PROV_SECURITY_1; // PoP

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, &prov_event_handler, NULL));
    ESP_ERROR_CHECK(wifi_prov_mgr_start_provisioning(security, (const void *)pop, service_name, NULL));
}

static void stop_provisioning(void)
{
    if (!s_provisioning) return;
    ESP_LOGI(TAG, "Stopping provisioning");
    wifi_prov_mgr_stop_provisioning();
    wifi_prov_mgr_deinit();
    esp_event_handler_unregister(WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, &prov_event_handler);
    s_provisioning = false;
}

static void enter_reprovision(void)
{
    ESP_LOGW(TAG, "Entering provisioning mode (reset credentials)");
    mqtt_stop();
    esp_wifi_disconnect();
    // Clear existing provisioning (Wi-Fi creds)
    wifi_prov_mgr_config_t cfg = {
        .scheme = wifi_prov_scheme_ble,
        .scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM,
    };
    ESP_ERROR_CHECK(wifi_prov_mgr_init(cfg));
    wifi_prov_mgr_reset_provisioning();
    wifi_prov_mgr_deinit();
    s_connect_fails = 0;
    start_provisioning();
}

static void start_wifi(void)
{
    ESP_LOGI(TAG, "Starting Wi-Fi STA");
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t) event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED:
        ESP_LOGI(TAG, "MQTT connected");
        xEventGroupSetBits(s_event_group, MQTT_CONNECTED_BIT);
        // Subscribe to command topic
        esp_mqtt_client_subscribe(s_mqtt, s_topic_cmd, 1);
        // Publish state online
        esp_mqtt_client_publish(s_mqtt, s_topic_state, "online", 0, 1, true);
        break;
    case MQTT_EVENT_DISCONNECTED:
        ESP_LOGW(TAG, "MQTT disconnected");
        xEventGroupClearBits(s_event_group, MQTT_CONNECTED_BIT);
        break;
    case MQTT_EVENT_DATA: {
        char topic[128] = {0};
        char data[256] = {0};
        int tlen = event->topic_len < (int)sizeof(topic)-1 ? event->topic_len : (int)sizeof(topic)-1;
        int dlen = event->data_len < (int)sizeof(data)-1 ? event->data_len : (int)sizeof(data)-1;
        memcpy(topic, event->topic, tlen); topic[tlen] = '\0';
        memcpy(data, event->data, dlen); data[dlen] = '\0';
        ESP_LOGI(TAG, "MQTT data on %s: %s", topic, data);

        if (strcmp(topic, s_topic_cmd) == 0) {
            // Simple commands: 'provision', 'set_broker <uri>'
            if (strncmp(data, "provision", 9) == 0) {
                enter_reprovision();
            } else if (strncmp(data, "set_broker ", 11) == 0) {
                const char *uri = data + 11;
                save_broker_uri(uri);
                ESP_LOGI(TAG, "Saved broker URI to NVS: %s", uri);
                // Reconnect MQTT with new broker
                mqtt_stop();
                mqtt_start();
            }
        }
        break; }
    default:
        break;
    }
}

static void mqtt_start(void)
{
    char broker[160];
    get_broker_uri(broker, sizeof(broker));
    ESP_LOGI(TAG, "MQTT broker: %s", broker);

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 0, 0)
    esp_mqtt_client_config_t cfg = {
        .broker = {
            .address = {
                .uri = broker,
            },
        },
        .session = {
            .last_will = {
                .topic = s_topic_state,
                .msg = "offline",
                .qos = 1,
                .retain = true,
            },
        },
        .credentials = {
            .client_id = s_device_id,
        },
    };
#else
    esp_mqtt_client_config_t cfg = {
        .uri = broker,
        .client_id = s_device_id,
        .lwt_topic = s_topic_state,
        .lwt_msg = "offline",
        .lwt_qos = 1,
        .lwt_retain = true,
    };
#endif

    s_mqtt = esp_mqtt_client_init(&cfg);
    ESP_ERROR_CHECK(esp_mqtt_client_register_event(s_mqtt, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL));
    ESP_ERROR_CHECK(esp_mqtt_client_start(s_mqtt));

    // Start telemetry task if not already
    static bool tele_task_started = false;
    if (!tele_task_started) {
        xTaskCreate(telemetry_task, "telemetry", 4096, NULL, 5, NULL);
        tele_task_started = true;
    }
}

static void mqtt_stop(void)
{
    if (s_mqtt) {
        esp_mqtt_client_stop(s_mqtt);
        esp_mqtt_client_destroy(s_mqtt);
        s_mqtt = NULL;
    }
}

static void telemetry_task(void *arg)
{
    while (1) {
        EventBits_t bits = xEventGroupGetBits(s_event_group);
        if ((bits & MQTT_CONNECTED_BIT) != 0 && s_mqtt) {
            // Gather simple telemetry: uptime and RSSI
            int64_t uptime_ms = esp_timer_get_time() / 1000;
            wifi_ap_record_t ap = (wifi_ap_record_t){0};
            int rssi = 0;
            if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
                rssi = ap.rssi;
            }
            char payload[128];
            snprintf(payload, sizeof(payload), "uptime_ms=%lld rssi=%d", (long long)uptime_ms, rssi);
            esp_mqtt_client_publish(s_mqtt, s_topic_tele, payload, 0, 0, false);
        }
        vTaskDelay(pdMS_TO_TICKS(CONFIG_PROJECTPLANT_TELEMETRY_SEC * 1000));
    }
}

static void button_task(void *arg)
{
    const gpio_num_t btn = (gpio_num_t)CONFIG_PROJECTPLANT_BUTTON_GPIO;
    int64_t press_start = 0;
    while (1) {
        int level = gpio_get_level(btn);
        if (level == 0) { // Active low button with pull-up
            if (press_start == 0) {
                press_start = esp_timer_get_time();
            } else {
                int64_t held_ms = (esp_timer_get_time() - press_start) / 1000;
                if (held_ms >= CONFIG_PROJECTPLANT_LONGPRESS_MS) {
                    ESP_LOGW(TAG, "Long press detected -> reprovision");
                    enter_reprovision();
                    // Debounce: wait for release
                    while (gpio_get_level(btn) == 0) {
                        vTaskDelay(pdMS_TO_TICKS(100));
                    }
                    press_start = 0;
                }
            }
        } else {
            press_start = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }

    s_event_group = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL));

    // Compute ID and topics
    get_device_id(s_device_id, sizeof(s_device_id));
    build_topics();
    ESP_LOGI(TAG, "Device ID: %s", s_device_id);
    ESP_LOGI(TAG, "Topics: tele=%s state=%s cmd=%s", s_topic_tele, s_topic_state, s_topic_cmd);

    // Button setup
    gpio_config_t io = {
        .pin_bit_mask = (1ULL << CONFIG_PROJECTPLANT_BUTTON_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io);
    xTaskCreate(button_task, "button", 2048, NULL, 10, NULL);

    // Provisioning manager: start provisioning if not configured
    bool provisioned = false;
    wifi_prov_mgr_config_t pm_cfg = {
        .scheme = wifi_prov_scheme_ble,
        .scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM,
    };
    ESP_ERROR_CHECK(wifi_prov_mgr_init(pm_cfg));
    ESP_ERROR_CHECK(wifi_prov_mgr_is_provisioned(&provisioned));
    wifi_prov_mgr_deinit();

    if (!provisioned) {
        start_provisioning();
    } else {
        start_wifi();
    }
}
