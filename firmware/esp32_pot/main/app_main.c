#include <stdint.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "freertos/timers.h"

#include "driver/gpio.h"
#include "esp_log.h"

#include "device_identity.h"
#include "hardware_config.h"
#include "node_schedule.h"
#include "plant_mqtt.h"
#include "sensors.h"
#include "startup_onboarding.h"
#include "time_sync.h"

#include "nvs_flash.h"
#include "preferences.h"

#define FW_VERSION "0.1.0"
#define BUTTON_TASK_STACK 3072
#define CONTROL_TASK_STACK 3072
#define PING_TASK_STACK 4096
#define SCHEDULE_TASK_STACK 4096
#define CONTROL_EVENT_QUEUE_DEPTH 8

typedef enum {
    CONTROL_EVENT_COMMAND = 0,
    CONTROL_EVENT_OVERRIDE_EXPIRED,
    CONTROL_EVENT_SNOOZE_TOGGLE,
    CONTROL_EVENT_SNOOZE_EXPIRED,
} control_event_type_t;

typedef struct {
    control_event_type_t type;
    union {
        mqtt_command_t command;
        struct {
            node_schedule_target_t target;
        } expiry;
    } data;
} control_event_t;

static const char *TAG = "app";

static QueueHandle_t measurement_queue;
static QueueHandle_t control_queue;
static esp_mqtt_client_handle_t mqtt_client = NULL;
static const char *device_id = NULL;

static TimerHandle_t pump_override_timer = NULL;
static TimerHandle_t ic_zone1_override_timer = NULL;
static TimerHandle_t fan_override_timer = NULL;
static TimerHandle_t mister_override_timer = NULL;
static TimerHandle_t light_override_timer = NULL;
static TimerHandle_t schedule_snooze_timer = NULL;
static char override_request_ids[NODE_SCHEDULE_TARGET_COUNT][MQTT_REQUEST_ID_MAX_LEN];

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

static void sanitize_uri(const char *uri, char *out, size_t out_len)
{
    if (!out || out_len == 0) {
        return;
    }

    if (!uri) {
        out[0] = '\0';
        return;
    }

    strncpy(out, uri, out_len - 1);
    out[out_len - 1] = '\0';

    char *scheme = strstr(out, "://");
    if (!scheme) {
        return;
    }

    char *userinfo = scheme + 3;
    char *at = strchr(userinfo, '@');
    if (!at) {
        return;
    }

    char *path = strpbrk(userinfo, "/?");
    if (path && at > path) {
        return;
    }

    memset(userinfo, '*', (size_t)(at - userinfo));
}

static void log_mqtt_uri(const char *label, const char *uri)
{
    char sanitized[160];

    sanitize_uri(uri, sanitized, sizeof(sanitized));
    if (sanitized[0]) {
        ESP_LOGI(TAG, "%s %s", label, sanitized);
    } else {
        ESP_LOGW(TAG, "%s <empty>", label);
    }
}

static const char *command_request_id_or_null(const mqtt_command_t *cmd)
{
    if (!cmd || !cmd->request_id[0]) {
        return NULL;
    }
    return cmd->request_id;
}

static void set_override_request_id(node_schedule_target_t target, const char *request_id)
{
    if ((int)target < 0 || target >= NODE_SCHEDULE_TARGET_COUNT) {
        return;
    }

    if (!request_id || !request_id[0]) {
        override_request_ids[target][0] = '\0';
        return;
    }

    strncpy(override_request_ids[target], request_id, MQTT_REQUEST_ID_MAX_LEN - 1);
    override_request_ids[target][MQTT_REQUEST_ID_MAX_LEN - 1] = '\0';
}

static const char *override_request_id_or_null(node_schedule_target_t target)
{
    if ((int)target < 0 || target >= NODE_SCHEDULE_TARGET_COUNT) {
        return NULL;
    }

    if (!override_request_ids[target][0]) {
        return NULL;
    }

    return override_request_ids[target];
}

static TimerHandle_t override_timer_for_target(node_schedule_target_t target)
{
    switch (target) {
    case NODE_SCHEDULE_TARGET_PUMP:
        return pump_override_timer;
    case NODE_SCHEDULE_TARGET_IC_ZONE1:
        return ic_zone1_override_timer;
    case NODE_SCHEDULE_TARGET_FAN:
        return fan_override_timer;
    case NODE_SCHEDULE_TARGET_MISTER:
        return mister_override_timer;
    case NODE_SCHEDULE_TARGET_LIGHT:
        return light_override_timer;
    default:
        return NULL;
    }
}

static bool target_is_on(node_schedule_target_t target)
{
    switch (target) {
    case NODE_SCHEDULE_TARGET_PUMP:
        return sensors_get_pump_state();
    case NODE_SCHEDULE_TARGET_IC_ZONE1:
        return sensors_get_ic_zone1_state();
    case NODE_SCHEDULE_TARGET_FAN:
        return sensors_get_fan_state();
    case NODE_SCHEDULE_TARGET_MISTER:
        return sensors_get_mister_state();
    case NODE_SCHEDULE_TARGET_LIGHT:
        return sensors_get_light_state();
    default:
        return false;
    }
}

static void publish_status(const char *status, const char *request_id)
{
    if (!mqtt_client || !status) {
        return;
    }

    mqtt_publish_status(mqtt_client, device_id, FW_VERSION, status, request_id);
}

static void publish_schedule_state(void)
{
    if (!mqtt_client) {
        return;
    }

    mqtt_publish_schedule_state(mqtt_client, device_id, FW_VERSION);
}

static void stop_override_timer(node_schedule_target_t target)
{
    TimerHandle_t timer = override_timer_for_target(target);
    if (!timer) {
        return;
    }

    if (xTimerStop(timer, 0) != pdPASS) {
        ESP_LOGW(TAG, "Failed to stop override timer for target %d", (int)target);
    }
}

static void arm_override_timer(node_schedule_target_t target, uint32_t duration_ms)
{
    TimerHandle_t timer = override_timer_for_target(target);
    if (!timer || duration_ms == 0) {
        return;
    }

    TickType_t ticks = pdMS_TO_TICKS(duration_ms);
    if (ticks == 0) {
        ticks = 1;
    }

    if (xTimerChangePeriod(timer, ticks, 0) != pdPASS) {
        ESP_LOGW(TAG, "Failed to arm override timer for target %d (%u ms)",
                 (int)target,
                 (unsigned)duration_ms);
    }
}

static void enqueue_expiry_event(node_schedule_target_t target)
{
    if (!control_queue) {
        return;
    }

    control_event_t event = {
        .type = CONTROL_EVENT_OVERRIDE_EXPIRED,
    };
    event.data.expiry.target = target;

    if (xQueueSend(control_queue, &event, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Control queue full, dropping expiry event for target %d", (int)target);
    }
}

static void enqueue_snooze_toggle_event(void)
{
    if (!control_queue) {
        return;
    }

    control_event_t event = {
        .type = CONTROL_EVENT_SNOOZE_TOGGLE,
    };

    if (xQueueSend(control_queue, &event, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Control queue full, dropping schedule snooze toggle event");
    }
}

static void enqueue_snooze_expiry_event(void)
{
    if (!control_queue) {
        return;
    }

    control_event_t event = {
        .type = CONTROL_EVENT_SNOOZE_EXPIRED,
    };

    if (xQueueSend(control_queue, &event, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Control queue full, dropping schedule snooze expiry event");
    }
}

static void override_timer_callback(TimerHandle_t timer)
{
    node_schedule_target_t target = (node_schedule_target_t)(uintptr_t)pvTimerGetTimerID(timer);
    enqueue_expiry_event(target);
}

static void schedule_snooze_timer_callback(TimerHandle_t timer)
{
    (void)timer;
    enqueue_snooze_expiry_event();
}

static bool create_override_timer(TimerHandle_t *timer, const char *name, node_schedule_target_t target)
{
    TickType_t initial_ticks = pdMS_TO_TICKS(1);
    if (initial_ticks == 0) {
        initial_ticks = 1;
    }

    *timer = xTimerCreate(
        name,
        initial_ticks,
        pdFALSE,
        (void *)(uintptr_t)target,
        override_timer_callback);
    if (!*timer) {
        ESP_LOGE(TAG, "Failed to create override timer %s", name);
        return false;
    }
    return true;
}

static bool init_override_timers(void)
{
    return create_override_timer(&pump_override_timer, "pump_ovr", NODE_SCHEDULE_TARGET_PUMP) &&
           create_override_timer(&ic_zone1_override_timer, "ic1_ovr", NODE_SCHEDULE_TARGET_IC_ZONE1) &&
           create_override_timer(&fan_override_timer, "fan_ovr", NODE_SCHEDULE_TARGET_FAN) &&
           create_override_timer(&mister_override_timer, "mist_ovr", NODE_SCHEDULE_TARGET_MISTER) &&
           create_override_timer(&light_override_timer, "light_ovr", NODE_SCHEDULE_TARGET_LIGHT);
}

static bool init_schedule_snooze_timer(void)
{
    TickType_t initial_ticks = pdMS_TO_TICKS(1);
    if (initial_ticks == 0) {
        initial_ticks = 1;
    }

    schedule_snooze_timer = xTimerCreate(
        "sched_snooze",
        initial_ticks,
        pdFALSE,
        NULL,
        schedule_snooze_timer_callback);
    if (!schedule_snooze_timer) {
        ESP_LOGE(TAG, "Failed to create schedule snooze timer");
        return false;
    }
    return true;
}

static void stop_schedule_snooze_timer(void)
{
    if (!schedule_snooze_timer) {
        return;
    }

    if (xTimerStop(schedule_snooze_timer, 0) != pdPASS) {
        ESP_LOGW(TAG, "Failed to stop schedule snooze timer");
    }
}

static bool arm_schedule_snooze_timer(uint32_t duration_ms)
{
    if (!schedule_snooze_timer || duration_ms == 0) {
        return false;
    }

    TickType_t ticks = pdMS_TO_TICKS(duration_ms);
    if (ticks == 0) {
        ticks = 1;
    }

    if (xTimerChangePeriod(schedule_snooze_timer, ticks, 0) != pdPASS) {
        ESP_LOGW(TAG, "Failed to arm schedule snooze timer (%u ms)", (unsigned)duration_ms);
        return false;
    }
    return true;
}

static bool init_schedule_button_gpio(void)
{
    gpio_config_t cfg = {
        .pin_bit_mask = BIT64(SCHEDULE_BUTTON_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to configure schedule button GPIO %d: %s",
                 (int)SCHEDULE_BUTTON_GPIO,
                 esp_err_to_name(err));
        return false;
    }
    return true;
}

static void restore_schedule_snooze_timer(void)
{
    uint64_t until_epoch_ms = 0;
    bool snoozed = node_schedule_get_snooze_state(&until_epoch_ms);
    if (!snoozed) {
        return;
    }

    uint32_t remaining_ms = node_schedule_get_snooze_remaining_ms();
    if (remaining_ms == 0) {
        ESP_LOGI(TAG, "Persisted schedule snooze already expired; clearing");
        esp_err_t err = node_schedule_set_snooze(false, 0, NULL);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to clear expired persisted schedule snooze: %s", esp_err_to_name(err));
        }
        return;
    }

    if (arm_schedule_snooze_timer(remaining_ms)) {
        ESP_LOGI(TAG, "Restored schedule snooze for %u ms (until=%llu)",
                 (unsigned)remaining_ms,
                 (unsigned long long)until_epoch_ms);
    }
}

static void handle_pump_override(const mqtt_command_t *cmd)
{
    const char *request_id = command_request_id_or_null(cmd);

    stop_override_timer(NODE_SCHEDULE_TARGET_PUMP);
    sensors_set_pump_state(cmd->pump_on);

    if (cmd->pump_on) {
        uint32_t effective_duration = node_schedule_set_override(
            NODE_SCHEDULE_TARGET_PUMP,
            true,
            cmd->duration_ms);
        set_override_request_id(NODE_SCHEDULE_TARGET_PUMP, request_id);
        arm_override_timer(NODE_SCHEDULE_TARGET_PUMP, effective_duration);
    } else {
        set_override_request_id(NODE_SCHEDULE_TARGET_PUMP, NULL);
        node_schedule_set_override(NODE_SCHEDULE_TARGET_PUMP, false, 0);
    }

    ESP_LOGI(TAG, "Pump command: %s duration %u ms",
             cmd->pump_on ? "ON" : "OFF",
             (unsigned)cmd->duration_ms);
    publish_status(cmd->pump_on ? "pump_on" : "pump_off", request_id);
}

static void handle_ic_zone1_override(const mqtt_command_t *cmd)
{
    const char *request_id = command_request_id_or_null(cmd);

    stop_override_timer(NODE_SCHEDULE_TARGET_IC_ZONE1);
    sensors_pulse_ic_zone1(cmd->ic_zone1_on, IC_ZONE1_PULSE_MS);
    sensors_set_ic_zone1_state(cmd->ic_zone1_on);

    if (cmd->ic_zone1_on) {
        uint32_t effective_duration = node_schedule_set_override(
            NODE_SCHEDULE_TARGET_IC_ZONE1,
            true,
            cmd->duration_ms);
        set_override_request_id(NODE_SCHEDULE_TARGET_IC_ZONE1, request_id);
        arm_override_timer(NODE_SCHEDULE_TARGET_IC_ZONE1, effective_duration);
    } else {
        set_override_request_id(NODE_SCHEDULE_TARGET_IC_ZONE1, NULL);
        node_schedule_set_override(NODE_SCHEDULE_TARGET_IC_ZONE1, false, 0);
    }

    ESP_LOGI(TAG, "IC Zone 1 command: %s duration %u ms",
             cmd->ic_zone1_on ? "ON" : "OFF",
             (unsigned)cmd->duration_ms);
    publish_status(cmd->ic_zone1_on ? "ic_zone1_on" : "ic_zone1_off", request_id);
}

static void handle_fan_override(const mqtt_command_t *cmd)
{
    const char *request_id = command_request_id_or_null(cmd);

    stop_override_timer(NODE_SCHEDULE_TARGET_FAN);
    sensors_set_fan_state(cmd->fan_on);

    if (cmd->fan_on) {
        uint32_t effective_duration = node_schedule_set_override(
            NODE_SCHEDULE_TARGET_FAN,
            true,
            cmd->duration_ms);
        set_override_request_id(NODE_SCHEDULE_TARGET_FAN, request_id);
        arm_override_timer(NODE_SCHEDULE_TARGET_FAN, effective_duration);
    } else {
        set_override_request_id(NODE_SCHEDULE_TARGET_FAN, NULL);
        node_schedule_set_override(NODE_SCHEDULE_TARGET_FAN, false, 0);
    }

    ESP_LOGI(TAG, "Fan command: %s duration %u ms",
             cmd->fan_on ? "ON" : "OFF",
             (unsigned)cmd->duration_ms);
    publish_status(cmd->fan_on ? "fan_on" : "fan_off", request_id);
}

static void handle_mister_override(const mqtt_command_t *cmd)
{
    const char *request_id = command_request_id_or_null(cmd);

    stop_override_timer(NODE_SCHEDULE_TARGET_MISTER);
    sensors_set_mister_state(cmd->mister_on);

    if (cmd->mister_on) {
        uint32_t effective_duration = node_schedule_set_override(
            NODE_SCHEDULE_TARGET_MISTER,
            true,
            cmd->duration_ms);
        set_override_request_id(NODE_SCHEDULE_TARGET_MISTER, request_id);
        arm_override_timer(NODE_SCHEDULE_TARGET_MISTER, effective_duration);
    } else {
        set_override_request_id(NODE_SCHEDULE_TARGET_MISTER, NULL);
        node_schedule_set_override(NODE_SCHEDULE_TARGET_MISTER, false, 0);
    }

    ESP_LOGI(TAG, "Mister command: %s duration %u ms",
             cmd->mister_on ? "ON" : "OFF",
             (unsigned)cmd->duration_ms);
    publish_status(cmd->mister_on ? "mister_on" : "mister_off", request_id);
}

static void handle_light_override(const mqtt_command_t *cmd)
{
    const char *request_id = command_request_id_or_null(cmd);

    stop_override_timer(NODE_SCHEDULE_TARGET_LIGHT);
    sensors_set_light_state(cmd->light_on);

    if (cmd->light_on) {
        uint32_t effective_duration = node_schedule_set_override(
            NODE_SCHEDULE_TARGET_LIGHT,
            true,
            cmd->duration_ms);
        set_override_request_id(NODE_SCHEDULE_TARGET_LIGHT, request_id);
        arm_override_timer(NODE_SCHEDULE_TARGET_LIGHT, effective_duration);
    } else {
        set_override_request_id(NODE_SCHEDULE_TARGET_LIGHT, NULL);
        node_schedule_set_override(NODE_SCHEDULE_TARGET_LIGHT, false, 0);
    }

    ESP_LOGI(TAG, "Light command: %s duration %u ms",
             cmd->light_on ? "ON" : "OFF",
             (unsigned)cmd->duration_ms);
    publish_status(cmd->light_on ? "light_on" : "light_off", request_id);
}

static void handle_override_expired(node_schedule_target_t target)
{
    char request_id_buf[MQTT_REQUEST_ID_MAX_LEN] = {0};
    const char *request_id = override_request_id_or_null(target);
    if (request_id) {
        strncpy(request_id_buf, request_id, sizeof(request_id_buf) - 1);
        request_id = request_id_buf;
    }

    stop_override_timer(target);
    set_override_request_id(target, NULL);
    node_schedule_set_override(target, false, 0);

    switch (target) {
    case NODE_SCHEDULE_TARGET_PUMP:
        if (!target_is_on(target)) {
            publish_status("pump_off", request_id);
        }
        break;
    case NODE_SCHEDULE_TARGET_IC_ZONE1:
        if (!target_is_on(target)) {
            publish_status("ic_zone1_off", request_id);
        }
        break;
    case NODE_SCHEDULE_TARGET_FAN:
        if (!target_is_on(target)) {
            publish_status("fan_timeout_off", request_id);
        }
        break;
    case NODE_SCHEDULE_TARGET_MISTER:
        if (!target_is_on(target)) {
            publish_status("mister_timeout_off", request_id);
        }
        break;
    case NODE_SCHEDULE_TARGET_LIGHT:
        if (!target_is_on(target)) {
            publish_status("light_timeout_off", request_id);
        }
        break;
    default:
        break;
    }
}

static void handle_schedule_snooze_toggle(void)
{
    uint64_t until_epoch_ms = 0;
    bool snoozed = node_schedule_get_snooze_state(&until_epoch_ms);
    esp_err_t err;

    if (snoozed) {
        stop_schedule_snooze_timer();
        err = node_schedule_set_snooze(false, 0, NULL);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to clear schedule snooze: %s", esp_err_to_name(err));
            restore_schedule_snooze_timer();
            return;
        }

        publish_status("schedule_resumed", NULL);
        publish_schedule_state();
        return;
    }

    err = node_schedule_set_snooze(true, SCHEDULE_SNOOZE_DURATION_MS, &until_epoch_ms);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to enable schedule snooze: %s", esp_err_to_name(err));
        return;
    }

    uint32_t remaining_ms = node_schedule_get_snooze_remaining_ms();
    if (remaining_ms == 0) {
        remaining_ms = SCHEDULE_SNOOZE_DURATION_MS;
    }
    if (!arm_schedule_snooze_timer(remaining_ms)) {
        ESP_LOGW(TAG, "Schedule snooze enabled without an active expiry timer");
    }

    publish_status("schedule_snoozed", NULL);
    publish_schedule_state();
}

static void handle_schedule_snooze_expired(void)
{
    if (!node_schedule_get_snooze_state(NULL)) {
        return;
    }

    stop_schedule_snooze_timer();
    esp_err_t err = node_schedule_set_snooze(false, 0, NULL);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to clear expired schedule snooze: %s", esp_err_to_name(err));
        return;
    }

    publish_status("schedule_snooze_expired", NULL);
    publish_schedule_state();
}

static void mqtt_command_dispatch(const mqtt_command_t *cmd)
{
    if (!cmd || !control_queue) {
        return;
    }

    control_event_t event = {
        .type = CONTROL_EVENT_COMMAND,
    };
    event.data.command = *cmd;

    if (xQueueSend(control_queue, &event, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Control queue full, dropping command");
    }
}

static void handle_control_task(void *arg)
{
    control_event_t event;

    while (true) {
        if (xQueueReceive(control_queue, &event, portMAX_DELAY) != pdTRUE) {
            continue;
        }

        switch (event.type) {
        case CONTROL_EVENT_OVERRIDE_EXPIRED:
            handle_override_expired(event.data.expiry.target);
            break;
        case CONTROL_EVENT_SNOOZE_TOGGLE:
            handle_schedule_snooze_toggle();
            break;
        case CONTROL_EVENT_SNOOZE_EXPIRED:
            handle_schedule_snooze_expired();
            break;
        case CONTROL_EVENT_COMMAND: {
            mqtt_command_t *cmd = &event.data.command;

            switch (cmd->type) {
            case MQTT_CMD_PUMP_OVERRIDE:
                handle_pump_override(cmd);
                break;
            case MQTT_CMD_IC_ZONE1_OVERRIDE:
                handle_ic_zone1_override(cmd);
                break;
            case MQTT_CMD_FAN_OVERRIDE:
                handle_fan_override(cmd);
                break;
            case MQTT_CMD_MISTER_OVERRIDE:
                handle_mister_override(cmd);
                break;
            case MQTT_CMD_LIGHT_OVERRIDE:
                handle_light_override(cmd);
                break;
            case MQTT_CMD_SENSOR_READ: {
                sensor_reading_t reading;
                sensors_collect(&reading);
                if (cmd->request_id[0]) {
                    ESP_LOGI(TAG, "Sensor read command (requestId=%s)", cmd->request_id);
                } else {
                    ESP_LOGI(TAG, "Sensor read command");
                }
                if (mqtt_client) {
                    mqtt_publish_reading(mqtt_client, device_id, &reading, command_request_id_or_null(cmd));
                }
                break;
            }
            case MQTT_CMD_CONFIG_UPDATE: {
                const char *request_id = command_request_id_or_null(cmd);
                if (cmd->device_name[0]) {
                    esp_err_t err = device_identity_set_name(cmd->device_name);
                    if (err == ESP_OK) {
                        ESP_LOGI(TAG, "Device name updated to %s", cmd->device_name);
                        publish_status("name_updated", request_id);
                    } else {
                        ESP_LOGW(TAG, "Failed to update device name: %s", esp_err_to_name(err));
                        publish_status("name_update_failed", request_id);
                    }
                }
                if (cmd->has_sensor_mode) {
                    esp_err_t err = device_identity_set_sensor_mode(cmd->sensor_mode);
                    if (err == ESP_OK) {
                        ESP_LOGI(TAG, "Sensor mode updated to %s", device_identity_sensor_mode_label());
                        publish_status("sensor_mode_updated", request_id);
                    } else {
                        ESP_LOGW(TAG, "Failed to update sensor mode: %s", esp_err_to_name(err));
                        publish_status("sensor_mode_update_failed", request_id);
                    }
                }
                if (cmd->has_schedule) {
                    esp_err_t err = node_schedule_set(&cmd->schedule);
                    if (err == ESP_OK) {
                        ESP_LOGI(TAG, "Device schedule updated");
                        publish_status("schedule_updated", request_id);
                    } else {
                        ESP_LOGW(TAG, "Failed to update device schedule: %s", esp_err_to_name(err));
                        publish_status("schedule_update_failed", request_id);
                    }
                }
                break;
            }
            default:
                ESP_LOGW(TAG, "Unhandled command type %d", cmd->type);
                break;
            }
            break;
        }
        default:
            ESP_LOGW(TAG, "Unhandled control event type %d", event.type);
            break;
        }
    }
}

static void schedule_button_task(void *arg)
{
    (void)arg;

    bool stable_pressed = gpio_get_level(SCHEDULE_BUTTON_GPIO) == 0;
    bool candidate_pressed = stable_pressed;
    uint32_t candidate_ms = SCHEDULE_BUTTON_DEBOUNCE_MS;
    bool pressed_since_release = false;

    while (true) {
        bool raw_pressed = gpio_get_level(SCHEDULE_BUTTON_GPIO) == 0;

        if (raw_pressed != candidate_pressed) {
            candidate_pressed = raw_pressed;
            candidate_ms = 0;
        } else if (candidate_ms < SCHEDULE_BUTTON_DEBOUNCE_MS) {
            candidate_ms += SCHEDULE_BUTTON_POLL_MS;
        }

        if (candidate_ms >= SCHEDULE_BUTTON_DEBOUNCE_MS &&
            stable_pressed != candidate_pressed) {
            stable_pressed = candidate_pressed;
            if (stable_pressed) {
                pressed_since_release = true;
            } else if (pressed_since_release) {
                enqueue_snooze_toggle_event();
                pressed_since_release = false;
            }
        }

        vTaskDelay(pdMS_TO_TICKS(SCHEDULE_BUTTON_POLL_MS));
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
    publish_status("online", NULL);

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
    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err == ESP_ERR_NVS_NO_FREE_PAGES || nvs_err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        nvs_err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(nvs_err);

    ESP_LOGI(TAG, "Starting ProjectPlant ESP32 node (%s)", FW_VERSION);
    ESP_LOGI(TAG, "test_var: '%c'", get_char("test_var", '0'));

    device_identity_init();
    device_id = device_identity_id();

    sensors_init();
    esp_err_t schedule_init_err = node_schedule_init();
    if (schedule_init_err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to initialize node schedule: %s", esp_err_to_name(schedule_init_err));
    }

    startup_onboarding_state_t onboarding = {0};
    while (true) {
        esp_err_t wifi_result = startup_onboarding_run(
            device_id,
            MQTT_BROKER_URI,
            WIFI_SSID,
            WIFI_PASS,
            &onboarding);
        if (wifi_result == ESP_OK && onboarding.wifi_connected) {
            break;
        }

        if (wifi_result == ESP_OK) {
            ESP_LOGE(TAG, "Network startup returned without Wi-Fi connectivity; retrying in 5 seconds");
        } else {
            ESP_LOGE(TAG, "Network startup failed: %s", esp_err_to_name(wifi_result));
            ESP_LOGI(TAG, "Retrying network startup in 5 seconds");
        }
        vTaskDelay(pdMS_TO_TICKS(5000));
    }

    if (onboarding.factory_default) {
        ESP_LOGI(
            TAG,
            "Factory-default onboarding complete (%s transport)",
            onboarding.ble_transport ? "BLE" : "SoftAP");
    }

    if (time_sync_init() == ESP_OK) {
        if (!time_sync_wait_for_valid(pdMS_TO_TICKS(15000))) {
            ESP_LOGW(TAG, "Time sync timed out; timestamps may be inaccurate");
        } else {
            ESP_LOGI(TAG, "Time synchronized successfully");
        }
    } else {
        ESP_LOGW(TAG, "Failed to initialize time sync; timestamps may be inaccurate");
    }

    measurement_queue = xQueueCreate(1, sizeof(sensor_reading_t));
    if (!measurement_queue) {
        ESP_LOGE(TAG, "Failed to create measurement queue");
    }

    xTaskCreate(sensor_task, "sensor_task", SENSOR_TASK_STACK, NULL, SENSOR_TASK_PRIORITY, NULL);
    xTaskCreate(node_schedule_task, "schedule_task", SCHEDULE_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);

    control_queue = xQueueCreate(CONTROL_EVENT_QUEUE_DEPTH, sizeof(control_event_t));
    if (!control_queue) {
        ESP_LOGE(TAG, "Failed to create control queue; local/MQTT control features unavailable");
        return;
    }

    if (!init_override_timers()) {
        ESP_LOGE(TAG, "Failed to initialize override timers; local/MQTT control features unavailable");
        return;
    }

    if (!init_schedule_snooze_timer()) {
        ESP_LOGE(TAG, "Failed to initialize schedule snooze timer; local button snooze unavailable");
        return;
    }

    if (!init_schedule_button_gpio()) {
        ESP_LOGE(TAG, "Failed to initialize schedule button GPIO; local button snooze unavailable");
        return;
    }

    restore_schedule_snooze_timer();
    xTaskCreate(handle_control_task, "control_task", CONTROL_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
    xTaskCreate(schedule_button_task, "button_task", BUTTON_TASK_STACK, NULL, SENSOR_TASK_PRIORITY, NULL);

    const char *mqtt_uri = onboarding.mqtt_uri[0] ? onboarding.mqtt_uri : MQTT_BROKER_URI;
    log_mqtt_uri("Resolved MQTT broker URI:", mqtt_uri);
    if (!mqtt_uri || !mqtt_uri[0]) {
        ESP_LOGE(TAG, "MQTT broker URI is empty; skipping MQTT startup");
        return;
    }

    mqtt_client = mqtt_client_start(
        mqtt_uri,
        device_id,
        MQTT_USERNAME,
        MQTT_PASSWORD,
        mqtt_command_dispatch);
    if (!mqtt_client) {
        ESP_LOGE(TAG, "MQTT client unavailable; MQTT tasks not started");
        return;
    }

    xTaskCreate(mqtt_task, "mqtt_task", MQTT_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
    xTaskCreate(ping_task, "ping_task", PING_TASK_STACK, NULL, MQTT_TASK_PRIORITY, NULL);
}
