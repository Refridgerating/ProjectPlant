#include "startup_onboarding.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs.h"
#include "protocomm_security.h"
#include "wifi_provisioning/manager.h"

#if CONFIG_BT_ENABLED
#include "protocomm_ble.h"
#include "wifi_provisioning/scheme_ble.h"
#else
#include "wifi_provisioning/scheme_softap.h"
#endif

#include "preferences.h"

#define ONBOARD_NAMESPACE "onboard"
#define ONBOARD_KEY_COMPLETE "complete"
#define ONBOARD_KEY_MQTT_URI "mqtt_uri"
#define ONBOARD_KEY_HUB_URL "hub_url"

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT BIT1
#define WIFI_MAX_RETRY 5
#define WIFI_CONNECT_TIMEOUT_MS 15000U

static const char *TAG = "startup_onboarding";

static EventGroupHandle_t wifi_event_group = NULL;
static int retry_count = 0;
static bool handlers_registered = false;
static bool wifi_stack_initialized = false;
static bool sta_netif_created = false;
#if !CONFIG_BT_ENABLED
static bool ap_netif_created = false;
#endif

static char mqtt_uri_state[STARTUP_MQTT_URI_MAX_LEN];
static char hub_url_state[STARTUP_HUB_URL_MAX_LEN];

static bool is_pref_missing(esp_err_t err)
{
    return err == ESP_ERR_NVS_NOT_FOUND || err == ESP_ERR_NVS_INVALID_NAME;
}

static void safe_copy(char *out, size_t out_len, const char *value)
{
    if (!out || out_len == 0) {
        return;
    }
    if (!value) {
        out[0] = '\0';
        return;
    }
    strncpy(out, value, out_len - 1);
    out[out_len - 1] = '\0';
}

static esp_err_t load_onboarding_complete(bool *out_complete, bool *out_missing)
{
    if (!out_complete || !out_missing) {
        return ESP_ERR_INVALID_ARG;
    }

    bool complete = false;
    esp_err_t err = prefs_get_bool(ONBOARD_NAMESPACE, ONBOARD_KEY_COMPLETE, &complete, false);
    if (err == ESP_OK) {
        *out_complete = complete;
        *out_missing = false;
        return ESP_OK;
    }
    if (is_pref_missing(err)) {
        *out_complete = false;
        *out_missing = true;
        return ESP_OK;
    }
    return err;
}

static esp_err_t persist_onboarding_complete(bool complete)
{
    return prefs_put_bool(ONBOARD_NAMESPACE, ONBOARD_KEY_COMPLETE, complete);
}

static esp_err_t load_persisted_str(const char *key, char *out_value, size_t out_value_len, const char *default_value)
{
    if (!key || !out_value || out_value_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    safe_copy(out_value, out_value_len, default_value);
    esp_err_t err = prefs_get_str(ONBOARD_NAMESPACE, key, out_value, out_value_len, default_value ? default_value : "");
    if (err == ESP_OK || is_pref_missing(err)) {
        return ESP_OK;
    }
    return err;
}

static esp_err_t persist_hub_settings(const char *mqtt_uri, const char *hub_url)
{
    if (!mqtt_uri || mqtt_uri[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t err = prefs_put_str(ONBOARD_NAMESPACE, ONBOARD_KEY_MQTT_URI, mqtt_uri);
    if (err != ESP_OK) {
        return err;
    }

    return prefs_put_str(ONBOARD_NAMESPACE, ONBOARD_KEY_HUB_URL, hub_url ? hub_url : "");
}

static void event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;

    if (event_base == WIFI_PROV_EVENT) {
        switch (event_id) {
        case WIFI_PROV_START:
            ESP_LOGI(TAG, "Provisioning started");
            break;
        case WIFI_PROV_CRED_RECV: {
            wifi_sta_config_t *wifi_sta_cfg = (wifi_sta_config_t *)event_data;
            if (wifi_sta_cfg) {
                ESP_LOGI(TAG, "Provisioning received Wi-Fi credentials (SSID=%s)", (const char *)wifi_sta_cfg->ssid);
            }
            break;
        }
        case WIFI_PROV_CRED_FAIL: {
            wifi_prov_sta_fail_reason_t *reason = (wifi_prov_sta_fail_reason_t *)event_data;
            const char *reason_str = "unknown";
            if (reason) {
                reason_str = (*reason == WIFI_PROV_STA_AUTH_ERROR) ? "auth_error" : "ap_not_found";
            }
            ESP_LOGW(TAG, "Provisioning Wi-Fi credential failure (%s), waiting for retry", reason_str);
            retry_count = 0;
            xEventGroupClearBits(wifi_event_group, WIFI_FAIL_BIT);
            wifi_prov_mgr_reset_sm_state_on_failure();
            break;
        }
        case WIFI_PROV_CRED_SUCCESS:
            ESP_LOGI(TAG, "Provisioning credentials accepted");
            break;
        case WIFI_PROV_END:
            ESP_LOGI(TAG, "Provisioning ended");
            break;
        default:
            break;
        }
    } else if (event_base == WIFI_EVENT) {
        switch (event_id) {
        case WIFI_EVENT_STA_START:
            esp_wifi_connect();
            break;
        case WIFI_EVENT_STA_DISCONNECTED:
            if (retry_count < WIFI_MAX_RETRY) {
                esp_wifi_connect();
                retry_count++;
                ESP_LOGW(TAG, "Retrying Wi-Fi connection (%d/%d)", retry_count, WIFI_MAX_RETRY);
            } else {
                xEventGroupSetBits(wifi_event_group, WIFI_FAIL_BIT);
            }
            break;
#if !CONFIG_BT_ENABLED
        case WIFI_EVENT_AP_STACONNECTED:
            ESP_LOGI(TAG, "SoftAP client connected");
            break;
        case WIFI_EVENT_AP_STADISCONNECTED:
            ESP_LOGI(TAG, "SoftAP client disconnected");
            break;
#endif
        default:
            break;
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        if (event) {
            ESP_LOGI(TAG, "Connected with IP " IPSTR, IP2STR(&event->ip_info.ip));
        } else {
            ESP_LOGI(TAG, "Connected with IP");
        }
        retry_count = 0;
        xEventGroupSetBits(wifi_event_group, WIFI_CONNECTED_BIT);
#if CONFIG_BT_ENABLED
    } else if (event_base == PROTOCOMM_TRANSPORT_BLE_EVENT) {
        if (event_id == PROTOCOMM_TRANSPORT_BLE_CONNECTED) {
            ESP_LOGI(TAG, "BLE provisioning client connected");
        } else if (event_id == PROTOCOMM_TRANSPORT_BLE_DISCONNECTED) {
            ESP_LOGI(TAG, "BLE provisioning client disconnected");
        }
#endif
    } else if (event_base == PROTOCOMM_SECURITY_SESSION_EVENT) {
        if (event_id == PROTOCOMM_SECURITY_SESSION_SETUP_OK) {
            ESP_LOGI(TAG, "Provisioning secure session established");
        } else if (event_id == PROTOCOMM_SECURITY_SESSION_CREDENTIALS_MISMATCH) {
            ESP_LOGW(TAG, "Provisioning security credentials mismatch");
        } else if (event_id == PROTOCOMM_SECURITY_SESSION_INVALID_SECURITY_PARAMS) {
            ESP_LOGW(TAG, "Provisioning security params invalid");
        }
    }
}

static esp_err_t init_wifi_stack(void)
{
    if (!wifi_event_group) {
        wifi_event_group = xEventGroupCreate();
        if (!wifi_event_group) {
            return ESP_ERR_NO_MEM;
        }
    }

    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        return err;
    }

    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        return err;
    }

    if (!handlers_registered) {
        err = esp_event_handler_register(WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL);
        if (err != ESP_OK) {
            return err;
        }
        err = esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL);
        if (err != ESP_OK) {
            return err;
        }
        err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, NULL);
        if (err != ESP_OK) {
            return err;
        }
#if CONFIG_BT_ENABLED
        err = esp_event_handler_register(PROTOCOMM_TRANSPORT_BLE_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL);
        if (err != ESP_OK) {
            return err;
        }
#endif
        err = esp_event_handler_register(PROTOCOMM_SECURITY_SESSION_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL);
        if (err != ESP_OK) {
            return err;
        }
        handlers_registered = true;
    }

    if (!sta_netif_created) {
        if (!esp_netif_create_default_wifi_sta()) {
            return ESP_FAIL;
        }
        sta_netif_created = true;
    }

#if !CONFIG_BT_ENABLED
    if (!ap_netif_created) {
        if (!esp_netif_create_default_wifi_ap()) {
            return ESP_FAIL;
        }
        ap_netif_created = true;
    }
#endif

    if (!wifi_stack_initialized) {
        wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
        err = esp_wifi_init(&cfg);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            return err;
        }
        wifi_stack_initialized = true;
    }

    return ESP_OK;
}

static esp_err_t wait_for_wifi(uint32_t timeout_ms)
{
    TickType_t timeout_ticks = timeout_ms == 0U ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
    EventBits_t bits = xEventGroupWaitBits(
        wifi_event_group,
        WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
        pdTRUE,
        pdFALSE,
        timeout_ticks);

    if (bits & WIFI_CONNECTED_BIT) {
        return ESP_OK;
    }
    if (bits & WIFI_FAIL_BIT) {
        return ESP_FAIL;
    }
    return ESP_ERR_TIMEOUT;
}

static esp_err_t connect_with_saved_credentials(uint32_t timeout_ms)
{
    if (!wifi_event_group) {
        return ESP_ERR_INVALID_STATE;
    }

    retry_count = 0;
    xEventGroupClearBits(wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);

    esp_err_t err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) {
        return err;
    }

    err = esp_wifi_start();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        return err;
    }

    err = esp_wifi_connect();
    if (err != ESP_OK && err != ESP_ERR_WIFI_CONN) {
        return err;
    }

    return wait_for_wifi(timeout_ms);
}

static esp_err_t connect_with_fallback_credentials(const char *ssid, const char *password, uint32_t timeout_ms)
{
    if (!ssid || !password || ssid[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    wifi_config_t wifi_config = {
        .sta = {
            .ssid = "",
            .password = "",
            .threshold.authmode = WIFI_AUTH_OPEN,
        },
    };
    strncpy((char *)wifi_config.sta.ssid, ssid, sizeof(wifi_config.sta.ssid) - 1);
    strncpy((char *)wifi_config.sta.password, password, sizeof(wifi_config.sta.password) - 1);

    esp_err_t err = esp_wifi_set_mode(WIFI_MODE_STA);
    if (err != ESP_OK) {
        return err;
    }
    err = esp_wifi_set_config(WIFI_IF_STA, &wifi_config);
    if (err != ESP_OK) {
        return err;
    }
    err = esp_wifi_start();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        return err;
    }

    retry_count = 0;
    xEventGroupClearBits(wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);
    err = esp_wifi_connect();
    if (err != ESP_OK && err != ESP_ERR_WIFI_CONN) {
        return err;
    }

    return wait_for_wifi(timeout_ms);
}

static void build_service_name(char *out_service_name, size_t out_service_name_len)
{
    if (!out_service_name || out_service_name_len == 0) {
        return;
    }

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(out_service_name, out_service_name_len, "PROV_%02X%02X%02X", mac[3], mac[4], mac[5]);
}

static void build_pop(char *out_pop, size_t out_pop_len, const char *device_id)
{
    if (!out_pop || out_pop_len == 0) {
        return;
    }

    if (device_id && device_id[0] != '\0') {
        size_t id_len = strlen(device_id);
        const char *suffix = id_len > 4 ? device_id + (id_len - 4) : device_id;
        snprintf(out_pop, out_pop_len, "pp-%s", suffix);
        return;
    }

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(out_pop, out_pop_len, "pp-%02X%02X%02X%02X", mac[2], mac[3], mac[4], mac[5]);
}

static esp_err_t build_hub_response(bool ok, const char *status, uint8_t **outbuf, ssize_t *outlen)
{
    if (!outbuf || !outlen) {
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *root = cJSON_CreateObject();
    if (!root) {
        return ESP_ERR_NO_MEM;
    }

    cJSON_AddBoolToObject(root, "ok", ok);
    cJSON_AddStringToObject(root, "status", status ? status : (ok ? "ok" : "error"));
    cJSON_AddStringToObject(root, "mqttUri", mqtt_uri_state);
    cJSON_AddStringToObject(root, "hubUrl", hub_url_state);

    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json) {
        return ESP_ERR_NO_MEM;
    }

    *outbuf = (uint8_t *)json;
    *outlen = (ssize_t)(strlen(json) + 1U);
    return ESP_OK;
}

static esp_err_t parse_hub_payload(const uint8_t *inbuf, ssize_t inlen, bool *out_changed)
{
    if (!out_changed) {
        return ESP_ERR_INVALID_ARG;
    }
    *out_changed = false;

    if (!inbuf || inlen <= 0) {
        return ESP_OK;
    }

    char *payload = (char *)malloc((size_t)inlen + 1U);
    if (!payload) {
        return ESP_ERR_NO_MEM;
    }
    memcpy(payload, inbuf, (size_t)inlen);
    payload[(size_t)inlen] = '\0';

    cJSON *root = cJSON_Parse(payload);
    free(payload);
    if (!root) {
        return ESP_ERR_INVALID_ARG;
    }

    const cJSON *mqtt_uri = cJSON_GetObjectItemCaseSensitive(root, "mqttUri");
    if (!cJSON_IsString(mqtt_uri) || !mqtt_uri->valuestring) {
        mqtt_uri = cJSON_GetObjectItemCaseSensitive(root, "mqtt_uri");
    }

    const cJSON *hub_url = cJSON_GetObjectItemCaseSensitive(root, "hubUrl");
    if (!cJSON_IsString(hub_url) || !hub_url->valuestring) {
        hub_url = cJSON_GetObjectItemCaseSensitive(root, "hub_url");
    }

    bool changed = false;
    if (cJSON_IsString(mqtt_uri) && mqtt_uri->valuestring && mqtt_uri->valuestring[0] != '\0') {
        safe_copy(mqtt_uri_state, sizeof(mqtt_uri_state), mqtt_uri->valuestring);
        changed = true;
    }
    if (cJSON_IsString(hub_url) && hub_url->valuestring) {
        safe_copy(hub_url_state, sizeof(hub_url_state), hub_url->valuestring);
        changed = true;
    }
    cJSON_Delete(root);

    if (changed) {
        esp_err_t err = persist_hub_settings(mqtt_uri_state, hub_url_state);
        if (err != ESP_OK) {
            return err;
        }
        *out_changed = true;
    }
    return ESP_OK;
}

static esp_err_t hub_data_handler(
    uint32_t session_id,
    const uint8_t *inbuf,
    ssize_t inlen,
    uint8_t **outbuf,
    ssize_t *outlen,
    void *priv_data)
{
    (void)session_id;
    (void)priv_data;

    if (!outbuf || !outlen) {
        return ESP_ERR_INVALID_ARG;
    }
    *outbuf = NULL;
    *outlen = 0;

    bool changed = false;
    esp_err_t err = parse_hub_payload(inbuf, inlen, &changed);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Hub payload parse failed: %s", esp_err_to_name(err));
        return build_hub_response(false, "invalid_payload", outbuf, outlen);
    }
    if (changed) {
        ESP_LOGI(TAG, "Updated onboarding hub config (mqttUri=%s hubUrl=%s)", mqtt_uri_state, hub_url_state);
    }

    return build_hub_response(true, "ok", outbuf, outlen);
}

esp_err_t startup_onboarding_run(
    const char *device_id,
    const char *default_mqtt_uri,
    const char *fallback_ssid,
    const char *fallback_password,
    startup_onboarding_state_t *out_state)
{
    if (!default_mqtt_uri || !out_state) {
        return ESP_ERR_INVALID_ARG;
    }

    memset(out_state, 0, sizeof(*out_state));

    safe_copy(mqtt_uri_state, sizeof(mqtt_uri_state), default_mqtt_uri);
    hub_url_state[0] = '\0';

    esp_err_t err = load_persisted_str(ONBOARD_KEY_MQTT_URI, mqtt_uri_state, sizeof(mqtt_uri_state), default_mqtt_uri);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to load mqtt_uri preference (%s), using default", esp_err_to_name(err));
    }
    err = load_persisted_str(ONBOARD_KEY_HUB_URL, hub_url_state, sizeof(hub_url_state), "");
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to load hub_url preference (%s), using empty", esp_err_to_name(err));
    }

    bool setup_complete = false;
    bool setup_missing = false;
    err = load_onboarding_complete(&setup_complete, &setup_missing);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to load onboarding completion flag (%s)", esp_err_to_name(err));
        setup_complete = false;
        setup_missing = true;
    }

    err = init_wifi_stack();
    if (err != ESP_OK) {
        return err;
    }

    wifi_prov_mgr_config_t prov_mgr_config = {
#if CONFIG_BT_ENABLED
        .scheme = wifi_prov_scheme_ble,
        .scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM,
#else
        .scheme = wifi_prov_scheme_softap,
        .scheme_event_handler = WIFI_PROV_EVENT_HANDLER_NONE,
#endif
        .app_event_handler = WIFI_PROV_EVENT_HANDLER_NONE,
        .wifi_prov_conn_cfg = {
            .wifi_conn_attempts = WIFI_MAX_RETRY,
        },
    };

    err = wifi_prov_mgr_init(prov_mgr_config);
    if (err != ESP_OK) {
        return err;
    }

    bool wifi_provisioned = false;
    err = wifi_prov_mgr_is_provisioned(&wifi_provisioned);
    if (err != ESP_OK) {
        wifi_prov_mgr_deinit();
        return err;
    }

    if (setup_missing && wifi_provisioned) {
        setup_complete = true;
        esp_err_t migrate_err = persist_onboarding_complete(true);
        if (migrate_err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to migrate onboarding complete flag: %s", esp_err_to_name(migrate_err));
        }
    }

    bool factory_default = !wifi_provisioned || !setup_complete;
    out_state->factory_default = factory_default;

    if (factory_default) {
        bool has_fallback_credentials = fallback_ssid && fallback_ssid[0] != '\0';
        if (has_fallback_credentials) {
            ESP_LOGI(TAG, "Factory-default device: trying firmware fallback Wi-Fi before provisioning");
            err = connect_with_fallback_credentials(
                fallback_ssid,
                fallback_password ? fallback_password : "",
                WIFI_CONNECT_TIMEOUT_MS);
            if (err == ESP_OK) {
                ESP_LOGI(TAG, "Fallback Wi-Fi connected; skipping provisioning");
                out_state->factory_default = false;
                out_state->provisioning_started = false;
                out_state->ble_transport = false;
                out_state->wifi_connected = true;

                esp_err_t persist_err = persist_onboarding_complete(true);
                if (persist_err != ESP_OK) {
                    ESP_LOGW(TAG, "Failed to persist onboarding complete flag: %s", esp_err_to_name(persist_err));
                }

                persist_err = persist_hub_settings(mqtt_uri_state, hub_url_state);
                if (persist_err != ESP_OK) {
                    ESP_LOGW(TAG, "Failed to persist hub settings: %s", esp_err_to_name(persist_err));
                }

                wifi_prov_mgr_deinit();
                safe_copy(out_state->mqtt_uri, sizeof(out_state->mqtt_uri), mqtt_uri_state);
                safe_copy(out_state->hub_url, sizeof(out_state->hub_url), hub_url_state);
                return ESP_OK;
            }

            ESP_LOGW(
                TAG,
                "Fallback Wi-Fi failed on factory-default device (%s); starting provisioning",
                esp_err_to_name(err));
        }

        out_state->provisioning_started = true;
#if CONFIG_BT_ENABLED
        out_state->ble_transport = true;
#else
        out_state->ble_transport = false;
        ESP_LOGW(TAG, "Bluetooth is disabled in sdkconfig, using SoftAP provisioning fallback");
#endif

        char service_name[16] = {0};
        char pop[20] = {0};
        build_service_name(service_name, sizeof(service_name));
        build_pop(pop, sizeof(pop), device_id);

        err = wifi_prov_mgr_endpoint_create("hub");
        if (err != ESP_OK) {
            wifi_prov_mgr_deinit();
            return err;
        }

        wifi_prov_security_t security = WIFI_PROV_SECURITY_1;
        wifi_prov_security1_params_t *sec_params = pop;

        err = wifi_prov_mgr_start_provisioning(
            security,
            (const void *)sec_params,
            service_name,
            NULL);
        if (err != ESP_OK) {
            wifi_prov_mgr_deinit();
            return err;
        }

        err = wifi_prov_mgr_endpoint_register("hub", hub_data_handler, NULL);
        if (err != ESP_OK) {
            wifi_prov_mgr_stop_provisioning();
            wifi_prov_mgr_deinit();
            return err;
        }

        ESP_LOGI(TAG, "Factory-default onboarding started (%s transport)", out_state->ble_transport ? "BLE" : "SoftAP");
        ESP_LOGI(TAG, "Provisioning service: %s", service_name);
        ESP_LOGI(TAG, "Proof-of-possession: %s", pop);
        ESP_LOGI(TAG, "Use ProjectPlant Provisioner to send Wi-Fi credentials and optional hub config");

        while (true) {
            EventBits_t bits = xEventGroupWaitBits(
                wifi_event_group,
                WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                pdTRUE,
                pdFALSE,
                portMAX_DELAY);

            if (bits & WIFI_CONNECTED_BIT) {
                break;
            }
            if (bits & WIFI_FAIL_BIT) {
                ESP_LOGW(TAG, "Provisioning credentials failed; waiting for another attempt");
            }
        }

        err = persist_onboarding_complete(true);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to persist onboarding complete flag: %s", esp_err_to_name(err));
        }

        err = persist_hub_settings(mqtt_uri_state, hub_url_state);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to persist hub settings: %s", esp_err_to_name(err));
        }

        wifi_prov_mgr_deinit();
        out_state->wifi_connected = true;
    } else {
        wifi_prov_mgr_deinit();

        err = connect_with_saved_credentials(WIFI_CONNECT_TIMEOUT_MS);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Stored Wi-Fi credentials failed (%s)", esp_err_to_name(err));
            if (fallback_ssid && fallback_password && fallback_ssid[0] != '\0') {
                ESP_LOGI(TAG, "Trying firmware fallback Wi-Fi credentials");
                err = connect_with_fallback_credentials(fallback_ssid, fallback_password, WIFI_CONNECT_TIMEOUT_MS);
            }
        }

        if (err != ESP_OK) {
            safe_copy(out_state->mqtt_uri, sizeof(out_state->mqtt_uri), mqtt_uri_state);
            safe_copy(out_state->hub_url, sizeof(out_state->hub_url), hub_url_state);
            out_state->wifi_connected = false;
            return err;
        }

        out_state->wifi_connected = true;
    }

    safe_copy(out_state->mqtt_uri, sizeof(out_state->mqtt_uri), mqtt_uri_state);
    safe_copy(out_state->hub_url, sizeof(out_state->hub_url), hub_url_state);
    return ESP_OK;
}
