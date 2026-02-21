#include "plant_mqtt.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/time.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "cJSON.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"

#include "hardware_config.h"
#include "time_sync.h"

static const char *TAG = "mqtt";
static mqtt_command_callback_t command_callback = NULL;
static char command_topic[96];
static char device_id_buffer[64];
static const uint64_t MIN_VALID_TIMESTAMP_MS = 1609459200ULL * 1000ULL;

static uint64_t current_epoch_ms(void);

static void log_stack_metrics(const char *label)
{
#if defined(INCLUDE_uxTaskGetStackHighWaterMark) && (INCLUDE_uxTaskGetStackHighWaterMark == 1)
    UBaseType_t watermark_words = uxTaskGetStackHighWaterMark(NULL);
    ESP_LOGD(TAG, "%s high-water mark: %lu words (%lu bytes)",
             label,
             (unsigned long)watermark_words,
             (unsigned long)watermark_words * sizeof(StackType_t));
#else
    ESP_LOGD(TAG, "%s high-water mark unavailable", label);
#endif

    (void)label;
}

static bool topic_equals(const char *topic, int topic_len, const char *expected)
{
    if (!topic || !expected) {
        return false;
    }
    size_t expected_len = strlen(expected);
    return topic_len == (int)expected_len && strncmp(topic, expected, expected_len) == 0;
}

static bool parse_schedule_timer(const cJSON *schedule_obj, const char *name, node_schedule_timer_t *out_timer)
{
    if (!schedule_obj || !name || !out_timer) {
        return false;
    }

    cJSON *timer_obj = cJSON_GetObjectItemCaseSensitive((cJSON *)schedule_obj, name);
    if (!cJSON_IsObject(timer_obj)) {
        return false;
    }

    cJSON *enabled = cJSON_GetObjectItemCaseSensitive(timer_obj, "enabled");
    cJSON *start_time = cJSON_GetObjectItemCaseSensitive(timer_obj, "startTime");
    cJSON *end_time = cJSON_GetObjectItemCaseSensitive(timer_obj, "endTime");
    if (!cJSON_IsBool(enabled) || !cJSON_IsString(start_time) || !start_time->valuestring ||
        !cJSON_IsString(end_time) || !end_time->valuestring) {
        return false;
    }

    uint16_t start_minute = 0;
    uint16_t end_minute = 0;
    if (!node_schedule_parse_hhmm(start_time->valuestring, &start_minute) ||
        !node_schedule_parse_hhmm(end_time->valuestring, &end_minute)) {
        return false;
    }

    out_timer->enabled = cJSON_IsTrue(enabled);
    out_timer->start_minute = start_minute;
    out_timer->end_minute = end_minute;
    return true;
}

static bool parse_schedule_config(cJSON *root, node_schedule_t *out_schedule)
{
    if (!root || !out_schedule) {
        return false;
    }

    cJSON *schedule_obj = cJSON_GetObjectItemCaseSensitive(root, "schedule");
    if (!cJSON_IsObject(schedule_obj)) {
        return false;
    }

    node_schedule_t parsed;
    node_schedule_defaults(&parsed);

    if (!parse_schedule_timer(schedule_obj, "light", &parsed.light) ||
        !parse_schedule_timer(schedule_obj, "pump", &parsed.pump) ||
        !parse_schedule_timer(schedule_obj, "mister", &parsed.mister) ||
        !parse_schedule_timer(schedule_obj, "fan", &parsed.fan)) {
        ESP_LOGW(TAG, "Invalid schedule payload; expected full timer config for light/pump/mister/fan");
        return false;
    }

    cJSON *tz_offset = cJSON_GetObjectItemCaseSensitive(root, "tzOffsetMinutes");
    if (!tz_offset) {
        tz_offset = cJSON_GetObjectItemCaseSensitive(schedule_obj, "tzOffsetMinutes");
    }
    if (cJSON_IsNumber(tz_offset)) {
        int tz_value = tz_offset->valueint;
        if (tz_value >= -720 && tz_value <= 840) {
            parsed.timezone_offset_minutes = (int16_t)tz_value;
        } else {
            ESP_LOGW(TAG, "tzOffsetMinutes out of range (%d); keeping default", tz_value);
        }
    }

    *out_schedule = parsed;
    return true;
}

void mqtt_publish_ping(esp_mqtt_client_handle_t client, const char *device_id)
{
    if (!client || !device_id || !device_id[0]) {
        return;
    }

    log_stack_metrics("mqtt_publish_ping:entry");
    const size_t local_bytes = sizeof(cJSON *) + sizeof(char *) + sizeof(int);
    ESP_LOGD(TAG, "mqtt_publish_ping locals estimate: %u bytes", (unsigned)local_bytes);

    cJSON *root = cJSON_CreateObject();
    if (!root) {
        return;
    }

    cJSON_AddStringToObject(root, "from", device_id);
    log_stack_metrics("mqtt_publish_ping:before current_epoch_ms");
    uint64_t timestamp_ms = current_epoch_ms();
    log_stack_metrics("mqtt_publish_ping:after current_epoch_ms");
    cJSON_AddNumberToObject(root, "timestampMs", (double)timestamp_ms);

    log_stack_metrics("mqtt_publish_ping:before cJSON_PrintUnformatted");
    char *payload = cJSON_PrintUnformatted(root);
    log_stack_metrics("mqtt_publish_ping:after cJSON_PrintUnformatted");
    cJSON_Delete(root);
    if (!payload) {
        return;
    }

    ESP_LOGD(TAG, "mqtt_publish_ping payload length: %u", (unsigned)strlen(payload));

    log_stack_metrics("mqtt_publish_ping:before esp_mqtt_client_publish");
    int msg_id = esp_mqtt_client_publish(client, MQTT_PING_TOPIC, payload, 0, 0, false);
    log_stack_metrics("mqtt_publish_ping:after esp_mqtt_client_publish");
    if (msg_id >= 0) {
        ESP_LOGI(TAG, "Published ping: %s", payload);
    } else {
        ESP_LOGW(TAG, "Failed to publish ping message");
    }
    cJSON_free(payload);
    log_stack_metrics("mqtt_publish_ping:exit");
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

static uint64_t current_epoch_ms(void)
{
    log_stack_metrics("current_epoch_ms:entry");
    struct timeval now;
    if (time_sync_is_time_valid() && gettimeofday(&now, NULL) == 0) {
        uint64_t ts = ((uint64_t)now.tv_sec * 1000ULL) + ((uint64_t)now.tv_usec / 1000ULL);
        ESP_LOGD(TAG, "current_epoch_ms synced timestamp: %llu", (unsigned long long)ts);
        log_stack_metrics("current_epoch_ms:exit");
        return ts;
    }
    uint64_t fallback = (uint64_t)(esp_timer_get_time() / 1000ULL);
    ESP_LOGD(TAG, "current_epoch_ms fallback timestamp: %llu", (unsigned long long)fallback);
    log_stack_metrics("current_epoch_ms:exit");
    return fallback;
}

static bool format_iso8601_timestamp(uint64_t timestamp_ms, char *buffer, size_t buffer_len)
{
    if (!buffer || buffer_len == 0) {
        return false;
    }

    time_t seconds = (time_t)(timestamp_ms / 1000ULL);
    struct tm tm_utc;
    if (gmtime_r(&seconds, &tm_utc) == NULL) {
        return false;
    }

    unsigned millis = (unsigned)(timestamp_ms % 1000ULL);
    int written = snprintf(
        buffer,
        buffer_len,
        "%04d-%02d-%02dT%02d:%02d:%02d.%03uZ",
        tm_utc.tm_year + 1900,
        tm_utc.tm_mon + 1,
        tm_utc.tm_mday,
        tm_utc.tm_hour,
        tm_utc.tm_min,
        tm_utc.tm_sec,
        millis
    );
    return written > 0 && (size_t)written < buffer_len;
}

static void add_common_fields(cJSON *root, const char *device_id, uint64_t timestamp_ms)
{
    cJSON_AddStringToObject(root, "potId", device_id);
    uint64_t effective_ts = timestamp_ms;
    if (effective_ts == 0) {
        effective_ts = current_epoch_ms();
    } else if (effective_ts < MIN_VALID_TIMESTAMP_MS) {
        uint64_t now_ms = current_epoch_ms();
        if (now_ms >= MIN_VALID_TIMESTAMP_MS) {
            effective_ts = now_ms;
        }
    }

    cJSON_AddNumberToObject(root, "timestampMs", (double)effective_ts);
    char iso_timestamp[32];
    if (format_iso8601_timestamp(effective_ts, iso_timestamp, sizeof(iso_timestamp))) {
        cJSON_AddStringToObject(root, "timestamp", iso_timestamp);
    }

    const char *device_name = device_identity_name();
    if (device_name && device_name[0]) {
        cJSON_AddStringToObject(root, "deviceName", device_name);
        cJSON_AddBoolToObject(root, "isNamed", device_identity_is_named());
    }
    cJSON_AddStringToObject(root, "sensorMode", device_identity_sensor_mode_label());
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
    cJSON_AddBoolToObject(root, "fanOn", reading->fan_is_on);
    cJSON_AddBoolToObject(root, "misterOn", reading->mister_is_on);
    cJSON_AddBoolToObject(root, "lightOn", reading->light_is_on);
    if (device_identity_sensors_enabled()) {
        cJSON_AddBoolToObject(root, "waterLow", reading->water_low);
        cJSON_AddBoolToObject(root, "waterCutoff", reading->water_cutoff);
        cJSON_AddNumberToObject(root, "soilRaw", reading->soil_raw);
    }

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
                         const char *status,
                         const char *request_id)
{
    if (!client || !device_id || !status) {
        return;
    }

    cJSON *root = cJSON_CreateObject();
    if (!root) {
        return;
    }

    add_common_fields(root, device_id, current_epoch_ms());
    cJSON_AddStringToObject(root, "status", status);
    if (request_id && request_id[0]) {
        cJSON_AddStringToObject(root, "requestId", request_id);
    }
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
        .device_name = "",
        .has_sensor_mode = false,
        .has_schedule = false,
        .sensor_mode = SENSOR_MODE_FULL,
        .pump_on = false,
        .fan_on = false,
        .mister_on = false,
        .light_on = false,
        .duration_ms = 0,
    };
    node_schedule_defaults(&cmd.schedule);

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

    cJSON *device_name = cJSON_GetObjectItemCaseSensitive(root, "deviceName");
    if (!device_name) {
        device_name = cJSON_GetObjectItemCaseSensitive(root, "displayName");
    }
    if (cJSON_IsString(device_name) && device_name->valuestring) {
        size_t name_len = strlen(device_name->valuestring);
        if (name_len > 0 && name_len < sizeof(cmd.device_name)) {
            memcpy(cmd.device_name, device_name->valuestring, name_len + 1);
            cmd.type = MQTT_CMD_CONFIG_UPDATE;
        } else {
            ESP_LOGW(TAG, "deviceName too long (%u), ignoring", (unsigned)name_len);
            cmd.device_name[0] = '\0';
        }
    }

    cJSON *sensor_mode = cJSON_GetObjectItemCaseSensitive(root, "sensorMode");
    if (cJSON_IsString(sensor_mode) && sensor_mode->valuestring) {
        if (strcasecmp(sensor_mode->valuestring, "control_only") == 0 ||
            strcasecmp(sensor_mode->valuestring, "control-only") == 0 ||
            strcasecmp(sensor_mode->valuestring, "control") == 0) {
            cmd.sensor_mode = SENSOR_MODE_CONTROL_ONLY;
            cmd.has_sensor_mode = true;
            cmd.type = MQTT_CMD_CONFIG_UPDATE;
        } else if (strcasecmp(sensor_mode->valuestring, "full") == 0 ||
                   strcasecmp(sensor_mode->valuestring, "sensors") == 0 ||
                   strcasecmp(sensor_mode->valuestring, "enabled") == 0) {
            cmd.sensor_mode = SENSOR_MODE_FULL;
            cmd.has_sensor_mode = true;
            cmd.type = MQTT_CMD_CONFIG_UPDATE;
        } else {
            ESP_LOGW(TAG, "Unknown sensorMode %s, ignoring", sensor_mode->valuestring);
        }
    }

    cJSON *sensors_enabled = cJSON_GetObjectItemCaseSensitive(root, "sensorsEnabled");
    if (cJSON_IsBool(sensors_enabled)) {
        cmd.sensor_mode = cJSON_IsTrue(sensors_enabled) ? SENSOR_MODE_FULL : SENSOR_MODE_CONTROL_ONLY;
        cmd.has_sensor_mode = true;
        cmd.type = MQTT_CMD_CONFIG_UPDATE;
    }

    if (parse_schedule_config(root, &cmd.schedule)) {
        cmd.has_schedule = true;
        cmd.type = MQTT_CMD_CONFIG_UPDATE;
    }

    if (cmd.type == MQTT_CMD_CONFIG_UPDATE) {
        cJSON_Delete(root);
        return cmd;
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
    } else {
        cJSON *fan = cJSON_GetObjectItemCaseSensitive(root, "fan");
        if (fan && (cJSON_IsBool(fan) || (cJSON_IsString(fan) && fan->valuestring))) {
            bool fan_on = false;
            if (cJSON_IsBool(fan)) {
                fan_on = cJSON_IsTrue(fan);
            } else if (strcmp(fan->valuestring, "on") == 0) {
                fan_on = true;
            } else if (strcmp(fan->valuestring, "off") == 0) {
                fan_on = false;
            }
            cmd.type = MQTT_CMD_FAN_OVERRIDE;
            cmd.fan_on = fan_on;

            cJSON *duration = cJSON_GetObjectItemCaseSensitive(root, "duration_ms");
            if (cJSON_IsNumber(duration) && duration->valueint > 0) {
                cmd.duration_ms = (uint32_t)duration->valueint;
            }
        } else {
            cJSON *mister = cJSON_GetObjectItemCaseSensitive(root, "mister");
            if (mister && (cJSON_IsBool(mister) || (cJSON_IsString(mister) && mister->valuestring))) {
                bool mister_on = false;
                if (cJSON_IsBool(mister)) {
                    mister_on = cJSON_IsTrue(mister);
                } else if (strcmp(mister->valuestring, "on") == 0) {
                    mister_on = true;
                } else if (strcmp(mister->valuestring, "off") == 0) {
                    mister_on = false;
                }
                cmd.type = MQTT_CMD_MISTER_OVERRIDE;
                cmd.mister_on = mister_on;

                cJSON *duration = cJSON_GetObjectItemCaseSensitive(root, "duration_ms");
                if (cJSON_IsNumber(duration) && duration->valueint > 0) {
                    cmd.duration_ms = (uint32_t)duration->valueint;
                }
            } else {
                cJSON *light = cJSON_GetObjectItemCaseSensitive(root, "light");
                if (light && (cJSON_IsBool(light) || (cJSON_IsString(light) && light->valuestring))) {
                    bool light_on = false;
                    if (cJSON_IsBool(light)) {
                        light_on = cJSON_IsTrue(light);
                    } else if (strcmp(light->valuestring, "on") == 0) {
                        light_on = true;
                    } else if (strcmp(light->valuestring, "off") == 0) {
                        light_on = false;
                    }
                    cmd.type = MQTT_CMD_LIGHT_OVERRIDE;
                    cmd.light_on = light_on;

                    cJSON *duration = cJSON_GetObjectItemCaseSensitive(root, "duration_ms");
                    if (cJSON_IsNumber(duration) && duration->valueint > 0) {
                        cmd.duration_ms = (uint32_t)duration->valueint;
                    }
                }
            }
        }
    }

    cJSON_Delete(root);
    return cmd;
}
