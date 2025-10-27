#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "esp_log.h"

#include "hardware_config.h"
#include "plant_mqtt.h"
#include "sensors.h"
#include "time_sync.h"
#include "wifi.h"

#define FW_VERSION "0.1.0"
#define COMMAND_TASK_STACK 3072
#define PING_TASK_STACK 4096

static const char *TAG = "app";

static QueueHandle_t measurement_queue;
static QueueHandle_t command_queue;
static esp_mqtt_client_handle_t mqtt_client = NULL;

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
                    mqtt_publish_status(mqtt_client, DEVICE_ID, FW_VERSION,
                                        cmd.pump_on ? "pump_on" : "pump_off",
                                        request_id);
                }
                if (cmd.pump_on && cmd.duration_ms > 0) {
                    vTaskDelay(pdMS_TO_TICKS(cmd.duration_ms));
                    sensors_set_pump_state(false);
                    if (mqtt_client) {
                        mqtt_publish_status(mqtt_client, DEVICE_ID, FW_VERSION, "pump_timeout_off", request_id);
                    }
                }
                break;
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
                    mqtt_publish_reading(mqtt_client, DEVICE_ID, &reading, request_id);
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
        mqtt_publish_status(mqtt_client, DEVICE_ID, FW_VERSION, "online", NULL);
    }
    while (true) {
        if (measurement_queue && xQueueReceive(measurement_queue, &reading, portMAX_DELAY) == pdTRUE) {
            if (mqtt_client) {
                mqtt_publish_reading(mqtt_client, DEVICE_ID, &reading, NULL);
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
            mqtt_publish_ping(mqtt_client, DEVICE_ID);
#if defined(INCLUDE_uxTaskGetStackHighWaterMark) && (INCLUDE_uxTaskGetStackHighWaterMark == 1)
            log_ping_task_watermark("ping_task after mqtt_publish_ping");
#endif
        }
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "Starting ProjectPlant ESP32 node (%s)", FW_VERSION);

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

    measurement_queue = xQueueCreate(1, sizeof(sensor_reading_t));
    command_queue = xQueueCreate(4, sizeof(mqtt_command_t));

    mqtt_client = mqtt_client_start(MQTT_BROKER_URI, DEVICE_ID, MQTT_USERNAME, MQTT_PASSWORD, mqtt_command_dispatch);

    xTaskCreate(sensor_task, "sensor_task", SENSOR_TASK_STACK, NULL, SENSOR_TASK_PRIORITY, NULL);
    xTaskCreate(mqtt_task, "mqtt_task", MQTT_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
    xTaskCreate(handle_command_task, "command_task", COMMAND_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
    xTaskCreate(ping_task, "ping_task", PING_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
}
