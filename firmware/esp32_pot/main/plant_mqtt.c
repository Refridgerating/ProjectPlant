#include "plant_mqtt.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "hardware_config.h"

static const char *TAG = "mqtt";
static mqtt_command_callback_t command_callback = NULL;
static char command_topic[96];

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = event_data;
    esp_mqtt_client_handle_t client = event->client;

    switch (event_id) {
    case MQTT_EVENT_CONNECTED:
        ESP_LOGI(TAG, "Connected to broker");
        esp_mqtt_client_subscribe(client, command_topic, 1);
        break;
    case MQTT_EVENT_DATA: {
        mqtt_command_t cmd = mqtt_parse_command(event->data, event->data_len);
        if (command_callback && cmd.type != MQTT_CMD_UNKNOWN) {
            command_callback(&cmd);
        }
        break;
    }
    default:
        break;
    }
}

esp_mqtt_client_handle_t mqtt_client_start(const char *uri,
                                           const char *device_id,
                                           const char *username,
                                           const char *password,
                                           mqtt_command_callback_t cb)
{
    command_callback = cb;
    snprintf(command_topic, sizeof(command_topic), COMMAND_TOPIC_FMT, device_id);

    esp_mqtt_client_config_t cfg = {
        .broker = {
            .address.uri = uri,
        },
        .credentials = {
            .username = username,
            .client_id = device_id,
            .authentication = {
                .password = password,
            },
        },
    };

    esp_mqtt_client_handle_t client = esp_mqtt_client_init(&cfg);
    if (!client) {
        ESP_LOGE(TAG, "Failed to init MQTT client");
        return NULL;
    }

    esp_mqtt_client_register_event(client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    esp_err_t err = esp_mqtt_client_start(client);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start MQTT client: %s", esp_err_to_name(err));
        return NULL;
    }

    return client;
}

static inline bool is_valid_float(float value)
{
    return !isnan(value) && !isinf(value);
}

static void add_common_fields(cJSON *root, const char *device_id, uint64_t timestamp_ms)
{
    cJSON_AddStringToObject(root, "potId", device_id);
    if (timestamp_ms > 0) {
        cJSON_AddNumberToObject(root, "timestampMs", (double)timestamp_ms);
    }
}

void mqtt_publish_reading(esp_mqtt_client_handle_t client,
                          const char *device_id,
                          const sensor_reading_t *reading)
{
    if (!client || !device_id || !reading) {
        return;
    }

    cJSON *root = cJSON_CreateObject();
    if (!root) {
        return;
    }

    add_common_fields(root, device_id, reading->timestamp_ms);

    float moisture = is_valid_float(reading->soil_percent) ? reading->soil_percent : 0.0f;
    float temperature = is_valid_float(reading->temperature_c) ? reading->temperature_c : 0.0f;

    cJSON_AddNumberToObject(root, "moisture", moisture);
    cJSON_AddNumberToObject(root, "temperature", temperature);
    if (is_valid_float(reading->humidity_pct)) {
        cJSON_AddNumberToObject(root, "humidity", reading->humidity_pct);
    }
    cJSON_AddBoolToObject(root, "valveOpen", reading->pump_is_on);
    cJSON_AddBoolToObject(root, "waterLow", reading->water_low);
    cJSON_AddBoolToObject(root, "waterCutoff", reading->water_cutoff);
    cJSON_AddNumberToObject(root, "soilRaw", reading->soil_raw);

    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!payload) {
        return;
    }

    char topic[96];
    snprintf(topic, sizeof(topic), SENSORS_TOPIC_FMT, device_id);
    esp_mqtt_client_publish(client, topic, payload, 0, 1, false);
    cJSON_free(payload);
}

void mqtt_publish_status(esp_mqtt_client_handle_t client,
                         const char *device_id,
                         const char *version,
                         const char *status)
{
    if (!client || !device_id || !status) {
        return;
    }

    cJSON *root = cJSON_CreateObject();
    if (!root) {
        return;
    }

    add_common_fields(root, device_id, esp_timer_get_time() / 1000ULL);
    cJSON_AddStringToObject(root, "status", status);
    if (version) {
        cJSON_AddStringToObject(root, "fwVersion", version);
    }

    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!payload) {
        return;
    }

    char topic[96];
    snprintf(topic, sizeof(topic), STATUS_TOPIC_FMT, device_id);
    esp_mqtt_client_publish(client, topic, payload, 0, 1, true);
    cJSON_free(payload);
}

mqtt_command_t mqtt_parse_command(const char *payload, int payload_len)
{
    mqtt_command_t cmd = {
        .type = MQTT_CMD_UNKNOWN,
        .pump_on = false,
        .duration_ms = 0,
    };

    if (!payload || payload_len <= 0) {
        return cmd;
    }

    char *buffer = calloc((size_t)payload_len + 1, sizeof(char));
    if (!buffer) {
        return cmd;
    }

    memcpy(buffer, payload, (size_t)payload_len);
    buffer[payload_len] = '\0';

    cJSON *root = cJSON_Parse(buffer);
    free(buffer);
    if (!root) {
        ESP_LOGW(TAG, "Failed to parse command JSON");
        return cmd;
    }

    cJSON *pump = cJSON_GetObjectItemCaseSensitive(root, "pump");
    if (pump && (cJSON_IsBool(pump) || (cJSON_IsString(pump) && pump->valuestring))) {
        bool pump_on = false;
        if (cJSON_IsBool(pump)) {
            pump_on = cJSON_IsTrue(pump);
        } else if (strcmp(pump->valuestring, "on") == 0) {
            pump_on = true;
        } else if (strcmp(pump->valuestring, "off") == 0) {
            pump_on = false;
        }
        cmd.type = MQTT_CMD_PUMP_OVERRIDE;
        cmd.pump_on = pump_on;

        cJSON *duration = cJSON_GetObjectItemCaseSensitive(root, "duration_ms");
        if (cJSON_IsNumber(duration) && duration->valueint > 0) {
            cmd.duration_ms = (uint32_t)duration->valueint;
        }
    }

    cJSON_Delete(root);
    return cmd;
}
