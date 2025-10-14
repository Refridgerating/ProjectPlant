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
static char device_id_buffer[64];

static bool topic_equals(const char *topic, int topic_len, const char *expected)
{
    if (!topic || !expected) {
        return false;
    }
    size_t expected_len = strlen(expected);
    return topic_len == (int)expected_len && strncmp(topic, expected, expected_len) == 0;
}

void mqtt_publish_ping(esp_mqtt_client_handle_t client, const char *device_id)
{
    if (!client || !device_id || !device_id[0]) {
        return;
    }

    cJSON *root = cJSON_CreateObject();
    if (!root) {
        return;
    }

    cJSON_AddStringToObject(root, "from", device_id);
    cJSON_AddNumberToObject(root, "timestampMs", (double)(esp_timer_get_time() / 1000ULL));

    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!payload) {
        return;
    }

    int msg_id = esp_mqtt_client_publish(client, MQTT_PING_TOPIC, payload, 0, 0, false);
    if (msg_id >= 0) {
        ESP_LOGI(TAG, "Published ping: %s", payload);
    } else {
        ESP_LOGW(TAG, "Failed to publish ping message");
    }
    cJSON_free(payload);
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_mqtt_event_handle_t event = event_data;
    esp_mqtt_client_handle_t client = event->client;

    switch (event_id) {
    case MQTT_EVENT_CONNECTED:
        ESP_LOGI(TAG, "Connected to broker");
        esp_mqtt_client_subscribe(client, command_topic, 1);
        esp_mqtt_client_subscribe(client, MQTT_PING_TOPIC, 0);
        if (device_id_buffer[0]) {
            mqtt_publish_ping(client, device_id_buffer);
        }
        break;
    case MQTT_EVENT_DATA: {
        if (topic_equals(event->topic, event->topic_len, command_topic)) {
            mqtt_command_t cmd = mqtt_parse_command(event->data, event->data_len);
            if (command_callback && cmd.type != MQTT_CMD_UNKNOWN) {
                command_callback(&cmd);
            }
        } else if (topic_equals(event->topic, event->topic_len, MQTT_PING_TOPIC)) {
            ESP_LOGI(TAG, "Ping topic %.*s payload %.*s",
                     event->topic_len, event->topic,
                     event->data_len, event->data);
        } else {
            ESP_LOGD(TAG, "Unhandled topic %.*s", event->topic_len, event->topic);
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
    device_id_buffer[0] = '\0';
    if (device_id) {
        strncpy(device_id_buffer, device_id, sizeof(device_id_buffer) - 1);
        device_id_buffer[sizeof(device_id_buffer) - 1] = '\0';
    }

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
                          const sensor_reading_t *reading,
                          const char *request_id)
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
    if (request_id && request_id[0]) {
        cJSON_AddStringToObject(root, "requestId", request_id);
    }

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
        .request_id = "",
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

    cJSON *request_id = cJSON_GetObjectItemCaseSensitive(root, "requestId");
    if (cJSON_IsString(request_id) && request_id->valuestring) {
        size_t id_len = strlen(request_id->valuestring);
        if (id_len < sizeof(cmd.request_id)) {
            memcpy(cmd.request_id, request_id->valuestring, id_len + 1);
        } else {
            ESP_LOGW(TAG, "requestId too long (%u), ignoring", (unsigned)id_len);
            cmd.request_id[0] = '\0';
        }
    }

    const char *action_value = NULL;
    cJSON *action = cJSON_GetObjectItemCaseSensitive(root, "action");
    if (cJSON_IsString(action) && action->valuestring) {
        action_value = action->valuestring;
    } else {
        cJSON *command = cJSON_GetObjectItemCaseSensitive(root, "command");
        if (cJSON_IsString(command) && command->valuestring) {
            action_value = command->valuestring;
        }
    }

    if (action_value &&
        (strcmp(action_value, "sensor_read") == 0 || strcmp(action_value, "sensorRead") == 0)) {
        cmd.type = MQTT_CMD_SENSOR_READ;
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
