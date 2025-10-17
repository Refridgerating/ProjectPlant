#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "esp_log.h"

#include "hardware_config.h"
#include "plant_mqtt.h"
#include "sensors.h"
#include "wifi.h"

#define FW_VERSION "0.1.0"
#define COMMAND_TASK_STACK 3072
#define PING_TASK_STACK 2048

static const char *TAG = "app";

static QueueHandle_t measurement_queue;
static QueueHandle_t command_queue;
static esp_mqtt_client_handle_t mqtt_client = NULL;

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
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(MQTT_PING_INTERVAL_MS));
        if (mqtt_client) {
            mqtt_publish_ping(mqtt_client, DEVICE_ID);
        }
    }
}

void app_main(void)
{
    ESP_LOGI(TAG, "Starting ProjectPlant ESP32 node (%s)", FW_VERSION);

    sensors_init();

    if (wifi_init_sta(WIFI_SSID, WIFI_PASS) != ESP_OK) {
        ESP_LOGE(TAG, "Wi-Fi connection failed; retry after delay");
        vTaskDelay(pdMS_TO_TICKS(5000));
    }

    measurement_queue = xQueueCreate(1, sizeof(sensor_reading_t));
    command_queue = xQueueCreate(4, sizeof(mqtt_command_t));

    mqtt_client = mqtt_client_start(MQTT_BROKER_URI, DEVICE_ID, MQTT_USERNAME, MQTT_PASSWORD, mqtt_command_dispatch);

    xTaskCreate(sensor_task, "sensor_task", SENSOR_TASK_STACK, NULL, SENSOR_TASK_PRIORITY, NULL);
    xTaskCreate(mqtt_task, "mqtt_task", MQTT_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
    xTaskCreate(handle_command_task, "command_task", COMMAND_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
    xTaskCreate(ping_task, "ping_task", PING_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
}
