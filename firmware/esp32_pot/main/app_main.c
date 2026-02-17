#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "esp_log.h"

#include "device_identity.h"
#include "hardware_config.h"
#include "plant_mqtt.h"
#include "sensors.h"
#include "time_sync.h"
#include "wifi.h"

#include "nvs_flash.h"  // for init. flash memory
#include "nvs.h"
#include "preferences.h"  // Chris

#define FW_VERSION "0.1.0"
#define COMMAND_TASK_STACK 3072
#define PING_TASK_STACK 4096

static const char *TAG = "app";

static QueueHandle_t measurement_queue;
static QueueHandle_t command_queue;
static esp_mqtt_client_handle_t mqtt_client = NULL;
static const char *device_id = NULL;

#if defined(INCLUDE_uxTaskGetStackHighWaterMark) && (INCLUDE_uxTaskGetStackHighWaterMark == 1)
static void log_ping_task_watermark(const char *label)
{
    UBaseType_t words = uxTaskGetStackHighWaterMark(NULL);
    ESP_LOGD(TAG, "%s high-water mark: %lu words (%lu bytes)",
             label,
             (unsigned long)words,
             (unsigned long)words * sizeof(StackType_t));
}
#else
static inline void log_ping_task_watermark(const char *label)
{
    (void)label;
}
#endif

static void mqtt_command_dispatch(const mqtt_command_t *cmd)
{
    if (!cmd || !command_queue) {
        return;
    }

    if (xQueueSend(command_queue, cmd, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Command queue full, dropping command");
    }
}

static void handle_command_task(void *arg)
{
    mqtt_command_t cmd;
    while (true) {
        if (xQueueReceive(command_queue, &cmd, portMAX_DELAY) == pdTRUE) {
            switch (cmd.type) {
            case MQTT_CMD_PUMP_OVERRIDE:
                ESP_LOGI(TAG, "Pump command: %s duration %u ms", cmd.pump_on ? "ON" : "OFF", (unsigned)cmd.duration_ms);
                sensors_set_pump_state(cmd.pump_on);
                const char *request_id = cmd.request_id[0] ? cmd.request_id : NULL;
                if (mqtt_client) {
                    mqtt_publish_status(mqtt_client, device_id, FW_VERSION,
                                        cmd.pump_on ? "pump_on" : "pump_off",
                                        request_id);
                }
                if (cmd.pump_on && cmd.duration_ms > 0) {
                    vTaskDelay(pdMS_TO_TICKS(cmd.duration_ms));
                    sensors_set_pump_state(false);
                    if (mqtt_client) {
                        mqtt_publish_status(mqtt_client, device_id, FW_VERSION, "pump_timeout_off", request_id);
                    }
                }
                break;
            case MQTT_CMD_FAN_OVERRIDE: {
                ESP_LOGI(TAG, "Fan command: %s duration %u ms", cmd.fan_on ? "ON" : "OFF", (unsigned)cmd.duration_ms);
                sensors_set_fan_state(cmd.fan_on);
                const char *fan_request_id = cmd.request_id[0] ? cmd.request_id : NULL;
                if (mqtt_client) {
                    mqtt_publish_status(mqtt_client, device_id, FW_VERSION,
                                        cmd.fan_on ? "fan_on" : "fan_off",
                                        fan_request_id);
                }
                if (cmd.fan_on && cmd.duration_ms > 0) {
                    vTaskDelay(pdMS_TO_TICKS(cmd.duration_ms));
                    sensors_set_fan_state(false);
                    if (mqtt_client) {
                        mqtt_publish_status(mqtt_client, device_id, FW_VERSION, "fan_timeout_off", fan_request_id);
                    }
                }
                break;
            }
            case MQTT_CMD_MISTER_OVERRIDE: {
                ESP_LOGI(TAG, "Mister command: %s duration %u ms", cmd.mister_on ? "ON" : "OFF", (unsigned)cmd.duration_ms);
                sensors_set_mister_state(cmd.mister_on);
                const char *mister_request_id = cmd.request_id[0] ? cmd.request_id : NULL;
                if (mqtt_client) {
                    mqtt_publish_status(mqtt_client, device_id, FW_VERSION,
                                        cmd.mister_on ? "mister_on" : "mister_off",
                                        mister_request_id);
                }
                if (cmd.mister_on && cmd.duration_ms > 0) {
                    vTaskDelay(pdMS_TO_TICKS(cmd.duration_ms));
                    sensors_set_mister_state(false);
                    if (mqtt_client) {
                        mqtt_publish_status(mqtt_client, device_id, FW_VERSION, "mister_timeout_off", mister_request_id);
                    }
                }
                break;
            }
            case MQTT_CMD_LIGHT_OVERRIDE: {
                ESP_LOGI(TAG, "Light command: %s duration %u ms", cmd.light_on ? "ON" : "OFF", (unsigned)cmd.duration_ms);
                sensors_set_light_state(cmd.light_on);
                const char *light_request_id = cmd.request_id[0] ? cmd.request_id : NULL;
                if (mqtt_client) {
                    mqtt_publish_status(mqtt_client, device_id, FW_VERSION,
                                        cmd.light_on ? "light_on" : "light_off",
                                        light_request_id);
                }
                if (cmd.light_on && cmd.duration_ms > 0) {
                    vTaskDelay(pdMS_TO_TICKS(cmd.duration_ms));
                    sensors_set_light_state(false);
                    if (mqtt_client) {
                        mqtt_publish_status(mqtt_client, device_id, FW_VERSION, "light_timeout_off", light_request_id);
                    }
                }
                break;
            }
            case MQTT_CMD_SENSOR_READ: {
                sensor_reading_t reading;
                sensors_collect(&reading);
                if (cmd.request_id[0]) {
                    ESP_LOGI(TAG, "Sensor read command (requestId=%s)", cmd.request_id);
                } else {
                    ESP_LOGI(TAG, "Sensor read command");
                }
                if (mqtt_client) {
                    const char *request_id = cmd.request_id[0] ? cmd.request_id : NULL;
                    mqtt_publish_reading(mqtt_client, device_id, &reading, request_id);
                }
                break;
            }
            case MQTT_CMD_CONFIG_UPDATE: {
                const char *request_id = cmd.request_id[0] ? cmd.request_id : NULL;
                if (cmd.device_name[0]) {
                    esp_err_t err = device_identity_set_name(cmd.device_name);
                    if (err == ESP_OK) {
                        ESP_LOGI(TAG, "Device name updated to %s", cmd.device_name);
                        if (mqtt_client) {
                            mqtt_publish_status(mqtt_client, device_id, FW_VERSION, "name_updated", request_id);
                        }
                    } else {
                        ESP_LOGW(TAG, "Failed to update device name: %s", esp_err_to_name(err));
                        if (mqtt_client) {
                            mqtt_publish_status(mqtt_client, device_id, FW_VERSION, "name_update_failed", request_id);
                        }
                    }
                }
                if (cmd.has_sensor_mode) {
                    esp_err_t err = device_identity_set_sensor_mode(cmd.sensor_mode);
                    if (err == ESP_OK) {
                        ESP_LOGI(TAG, "Sensor mode updated to %s", device_identity_sensor_mode_label());
                        if (mqtt_client) {
                            mqtt_publish_status(mqtt_client, device_id, FW_VERSION, "sensor_mode_updated", request_id);
                        }
                    } else {
                        ESP_LOGW(TAG, "Failed to update sensor mode: %s", esp_err_to_name(err));
                        if (mqtt_client) {
                            mqtt_publish_status(mqtt_client, device_id, FW_VERSION, "sensor_mode_update_failed", request_id);
                        }
                    }
                }
                break;
            }
            default:
                ESP_LOGW(TAG, "Unhandled command type %d", cmd.type);
                break;
            }
        }
    }
}

static void sensor_task(void *arg)
{
    sensor_reading_t reading;
    while (true) {
        sensors_collect(&reading);
        if (measurement_queue) {
            if (xQueueSend(measurement_queue, &reading, 0) != pdTRUE) {
                xQueueOverwrite(measurement_queue, &reading);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(MEASUREMENT_INTERVAL_MS));
    }
}

static void mqtt_task(void *arg)
{
    sensor_reading_t reading;
    vTaskDelay(pdMS_TO_TICKS(2000));
    if (mqtt_client) {
        mqtt_publish_status(mqtt_client, device_id, FW_VERSION, "online", NULL);
    }
    while (true) {
        if (measurement_queue && xQueueReceive(measurement_queue, &reading, portMAX_DELAY) == pdTRUE) {
            if (mqtt_client) {
                mqtt_publish_reading(mqtt_client, device_id, &reading, NULL);
            }
        }
    }
}

static void ping_task(void *arg)
{
#if defined(INCLUDE_uxTaskGetStackHighWaterMark) && (INCLUDE_uxTaskGetStackHighWaterMark == 1)
    log_ping_task_watermark("ping_task initial");
#endif
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(MQTT_PING_INTERVAL_MS));
        if (mqtt_client) {
#if defined(INCLUDE_uxTaskGetStackHighWaterMark) && (INCLUDE_uxTaskGetStackHighWaterMark == 1)
            log_ping_task_watermark("ping_task before mqtt_publish_ping");
#endif
            mqtt_publish_ping(mqtt_client, device_id);
#if defined(INCLUDE_uxTaskGetStackHighWaterMark) && (INCLUDE_uxTaskGetStackHighWaterMark == 1)
            log_ping_task_watermark("ping_task after mqtt_publish_ping");
#endif
        }
    }
}

void app_main(void)
{
    nvs_flash_init();  // Chris

    ESP_LOGI(TAG, "Starting ProjectPlant ESP32 node (%s)", FW_VERSION);
    ESP_LOGI(TAG, "test_var: '%c'", get_char("test_var", '0'));  // DEBUG

    sensors_init();

    esp_err_t wifi_result = wifi_init_sta(WIFI_SSID, WIFI_PASS);
    if (wifi_result != ESP_OK) {
        ESP_LOGE(TAG, "Wi-Fi connection failed; retry after delay");
        vTaskDelay(pdMS_TO_TICKS(5000));
    } else {
        if (time_sync_init() == ESP_OK) {
            if (!time_sync_wait_for_valid(pdMS_TO_TICKS(15000))) {
                ESP_LOGW(TAG, "Time sync timed out; timestamps may be inaccurate");
            } else {
                ESP_LOGI(TAG, "Time synchronized successfully");
            }
        } else {
            ESP_LOGW(TAG, "Failed to initialize time sync; timestamps may be inaccurate");
        }
    }

    device_identity_init();
    device_id = device_identity_id();

    measurement_queue = xQueueCreate(1, sizeof(sensor_reading_t));
    command_queue = xQueueCreate(4, sizeof(mqtt_command_t));

    mqtt_client = mqtt_client_start(MQTT_BROKER_URI, device_id, MQTT_USERNAME, MQTT_PASSWORD, mqtt_command_dispatch);

    xTaskCreate(sensor_task, "sensor_task", SENSOR_TASK_STACK, NULL, SENSOR_TASK_PRIORITY, NULL);
    xTaskCreate(mqtt_task, "mqtt_task", MQTT_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
    xTaskCreate(handle_command_task, "command_task", COMMAND_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
    xTaskCreate(ping_task, "ping_task", PING_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
}
