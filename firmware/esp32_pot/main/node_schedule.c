#include "node_schedule.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <sys/time.h>

#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"

#include "esp_timer.h"
#include "preferences.h"
#include "hardware_config.h"
#include "sensors.h"
#include "time_sync.h"

#define SCHEDULE_NAMESPACE "schedule"
#define SCHEDULE_TASK_PERIOD_MS 10000
#define DEFAULT_SCHEDULE_OVERRIDE_DURATION_MS (10U * SCHEDULE_TASK_PERIOD_MS)

static const char *TAG = "node_schedule";

static const int16_t TZ_OFFSET_MIN = -720;
static const int16_t TZ_OFFSET_MAX = 840;

static SemaphoreHandle_t schedule_lock = NULL;
static node_schedule_t schedule_state;
static bool schedule_initialized = false;

typedef struct {
    bool active;
    uint64_t expires_at_ms;
} schedule_override_t;

static schedule_override_t override_light = {0};
static schedule_override_t override_pump = {0};
static schedule_override_t override_ic_zone1 = {0};
static schedule_override_t override_mister = {0};
static schedule_override_t override_fan = {0};

static const node_schedule_timer_t DEFAULT_LIGHT = { .enabled = false, .start_minute = 6 * 60, .end_minute = 20 * 60 };
static const node_schedule_timer_t DEFAULT_PUMP = { .enabled = false, .start_minute = 7 * 60, .end_minute = (7 * 60) + 15 };
static const node_schedule_timer_t DEFAULT_IC_ZONE1 = { .enabled = false, .start_minute = 7 * 60, .end_minute = (7 * 60) + 15 };
static const node_schedule_timer_t DEFAULT_MISTER = { .enabled = false, .start_minute = 8 * 60, .end_minute = (8 * 60) + 15 };
static const node_schedule_timer_t DEFAULT_FAN = { .enabled = false, .start_minute = 9 * 60, .end_minute = 18 * 60 };

static bool is_pref_missing(esp_err_t err)
{
    return err == ESP_ERR_NVS_NOT_FOUND || err == ESP_ERR_NVS_INVALID_NAME;
}

static bool is_valid_timer(const node_schedule_timer_t *timer)
{
    if (!timer) {
        return false;
    }
    return timer->start_minute < 1440U && timer->end_minute < 1440U;
}

static bool is_valid_schedule(const node_schedule_t *schedule)
{
    if (!schedule) {
        return false;
    }
    if (!is_valid_timer(&schedule->light) ||
        !is_valid_timer(&schedule->pump) ||
        !is_valid_timer(&schedule->ic_zone1) ||
        !is_valid_timer(&schedule->mister) ||
        !is_valid_timer(&schedule->fan)) {
        return false;
    }
    return schedule->timezone_offset_minutes >= TZ_OFFSET_MIN &&
           schedule->timezone_offset_minutes <= TZ_OFFSET_MAX;
}

static uint64_t monotonic_ms(void)
{
    return (uint64_t)(esp_timer_get_time() / 1000ULL);
}

static bool override_should_skip(schedule_override_t *ovr)
{
    if (!ovr || !ovr->active) {
        return false;
    }

    if (monotonic_ms() >= ovr->expires_at_ms) {
        ovr->active = false;
        return false;
    }
    return true;
}

static schedule_override_t *override_for_target(node_schedule_target_t target)
{
    switch (target) {
    case NODE_SCHEDULE_TARGET_LIGHT:
        return &override_light;
    case NODE_SCHEDULE_TARGET_PUMP:
        return &override_pump;
    case NODE_SCHEDULE_TARGET_IC_ZONE1:
        return &override_ic_zone1;
    case NODE_SCHEDULE_TARGET_MISTER:
        return &override_mister;
    case NODE_SCHEDULE_TARGET_FAN:
        return &override_fan;
    default:
        return NULL;
    }
}

static const char *target_name(node_schedule_target_t target)
{
    switch (target) {
    case NODE_SCHEDULE_TARGET_LIGHT:
        return "light";
    case NODE_SCHEDULE_TARGET_PUMP:
        return "pump";
    case NODE_SCHEDULE_TARGET_IC_ZONE1:
        return "ic_zone1";
    case NODE_SCHEDULE_TARGET_MISTER:
        return "mister";
    case NODE_SCHEDULE_TARGET_FAN:
        return "fan";
    default:
        return "unknown";
    }
}

static uint32_t override_duration_ms(uint32_t duration_ms)
{
    return duration_ms > 0 ? duration_ms : DEFAULT_SCHEDULE_OVERRIDE_DURATION_MS;
}

void node_schedule_defaults(node_schedule_t *out_schedule)
{
    if (!out_schedule) {
        return;
    }
    out_schedule->light = DEFAULT_LIGHT;
    out_schedule->pump = DEFAULT_PUMP;
    out_schedule->ic_zone1 = DEFAULT_IC_ZONE1;
    out_schedule->mister = DEFAULT_MISTER;
    out_schedule->fan = DEFAULT_FAN;
    out_schedule->timezone_offset_minutes = 0;
    out_schedule->updated_at_ms = 0;
}

bool node_schedule_parse_hhmm(const char *value, uint16_t *out_minutes)
{
    if (!value || !out_minutes) {
        return false;
    }

    if (strlen(value) != 5 || value[2] != ':') {
        return false;
    }

    if (value[0] < '0' || value[0] > '9' ||
        value[1] < '0' || value[1] > '9' ||
        value[3] < '0' || value[3] > '9' ||
        value[4] < '0' || value[4] > '9') {
        return false;
    }

    int hour = ((int)value[0] - '0') * 10 + ((int)value[1] - '0');
    int minute = ((int)value[3] - '0') * 10 + ((int)value[4] - '0');
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return false;
    }

    *out_minutes = (uint16_t)(hour * 60 + minute);
    return true;
}

static bool timer_is_active(const node_schedule_timer_t *timer, int minute_of_day)
{
    if (!timer || !timer->enabled) {
        return false;
    }

    int start = (int)timer->start_minute;
    int end = (int)timer->end_minute;

    if (start == end) {
        return true;
    }

    if (start < end) {
        return minute_of_day >= start && minute_of_day < end;
    }

    return minute_of_day >= start || minute_of_day < end;
}

static esp_err_t save_schedule_locked(const node_schedule_t *schedule)
{
    esp_err_t err = prefs_put_bool(SCHEDULE_NAMESPACE, "l_en", schedule->light.enabled);
    if (err != ESP_OK) {
        return err;
    }
    err = prefs_put_u32(SCHEDULE_NAMESPACE, "l_st", schedule->light.start_minute);
    if (err != ESP_OK) {
        return err;
    }
    err = prefs_put_u32(SCHEDULE_NAMESPACE, "l_et", schedule->light.end_minute);
    if (err != ESP_OK) {
        return err;
    }

    err = prefs_put_bool(SCHEDULE_NAMESPACE, "p_en", schedule->pump.enabled);
    if (err != ESP_OK) {
        return err;
    }
    err = prefs_put_u32(SCHEDULE_NAMESPACE, "p_st", schedule->pump.start_minute);
    if (err != ESP_OK) {
        return err;
    }
    err = prefs_put_u32(SCHEDULE_NAMESPACE, "p_et", schedule->pump.end_minute);
    if (err != ESP_OK) {
        return err;
    }

    err = prefs_put_bool(SCHEDULE_NAMESPACE, "i_en", schedule->ic_zone1.enabled);
    if (err != ESP_OK) {
        return err;
    }
    err = prefs_put_u32(SCHEDULE_NAMESPACE, "i_st", schedule->ic_zone1.start_minute);
    if (err != ESP_OK) {
        return err;
    }
    err = prefs_put_u32(SCHEDULE_NAMESPACE, "i_et", schedule->ic_zone1.end_minute);
    if (err != ESP_OK) {
        return err;
    }

    err = prefs_put_bool(SCHEDULE_NAMESPACE, "m_en", schedule->mister.enabled);
    if (err != ESP_OK) {
        return err;
    }
    err = prefs_put_u32(SCHEDULE_NAMESPACE, "m_st", schedule->mister.start_minute);
    if (err != ESP_OK) {
        return err;
    }
    err = prefs_put_u32(SCHEDULE_NAMESPACE, "m_et", schedule->mister.end_minute);
    if (err != ESP_OK) {
        return err;
    }

    err = prefs_put_bool(SCHEDULE_NAMESPACE, "f_en", schedule->fan.enabled);
    if (err != ESP_OK) {
        return err;
    }
    err = prefs_put_u32(SCHEDULE_NAMESPACE, "f_st", schedule->fan.start_minute);
    if (err != ESP_OK) {
        return err;
    }
    err = prefs_put_u32(SCHEDULE_NAMESPACE, "f_et", schedule->fan.end_minute);
    if (err != ESP_OK) {
        return err;
    }

    err = prefs_put_i32(SCHEDULE_NAMESPACE, "tz_ofs", (int32_t)schedule->timezone_offset_minutes);
    if (err != ESP_OK) {
        return err;
    }

    return prefs_put_u64(SCHEDULE_NAMESPACE, "upd_ms", schedule->updated_at_ms);
}

static esp_err_t load_schedule_locked(node_schedule_t *schedule)
{
    if (!schedule) {
        return ESP_ERR_INVALID_ARG;
    }

    node_schedule_defaults(schedule);
    esp_err_t err = ESP_OK;

    bool b = false;
    uint32_t u = 0;
    int32_t tz = 0;
    uint64_t updated_ms = 0;

    b = schedule->light.enabled;
    err = prefs_get_bool(SCHEDULE_NAMESPACE, "l_en", &b, schedule->light.enabled);
    if (err == ESP_OK || is_pref_missing(err)) {
        schedule->light.enabled = b;
    } else {
        return err;
    }
    u = schedule->light.start_minute;
    err = prefs_get_u32(SCHEDULE_NAMESPACE, "l_st", &u, schedule->light.start_minute);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (u < 1440U) {
            schedule->light.start_minute = (uint16_t)u;
        }
    } else {
        return err;
    }
    u = schedule->light.end_minute;
    err = prefs_get_u32(SCHEDULE_NAMESPACE, "l_et", &u, schedule->light.end_minute);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (u < 1440U) {
            schedule->light.end_minute = (uint16_t)u;
        }
    } else {
        return err;
    }

    b = schedule->pump.enabled;
    err = prefs_get_bool(SCHEDULE_NAMESPACE, "p_en", &b, schedule->pump.enabled);
    if (err == ESP_OK || is_pref_missing(err)) {
        schedule->pump.enabled = b;
    } else {
        return err;
    }
    u = schedule->pump.start_minute;
    err = prefs_get_u32(SCHEDULE_NAMESPACE, "p_st", &u, schedule->pump.start_minute);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (u < 1440U) {
            schedule->pump.start_minute = (uint16_t)u;
        }
    } else {
        return err;
    }
    u = schedule->pump.end_minute;
    err = prefs_get_u32(SCHEDULE_NAMESPACE, "p_et", &u, schedule->pump.end_minute);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (u < 1440U) {
            schedule->pump.end_minute = (uint16_t)u;
        }
    } else {
        return err;
    }

    b = schedule->ic_zone1.enabled;
    err = prefs_get_bool(SCHEDULE_NAMESPACE, "i_en", &b, schedule->ic_zone1.enabled);
    if (err == ESP_OK || is_pref_missing(err)) {
        schedule->ic_zone1.enabled = b;
    } else {
        return err;
    }
    u = schedule->ic_zone1.start_minute;
    err = prefs_get_u32(SCHEDULE_NAMESPACE, "i_st", &u, schedule->ic_zone1.start_minute);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (u < 1440U) {
            schedule->ic_zone1.start_minute = (uint16_t)u;
        }
    } else {
        return err;
    }
    u = schedule->ic_zone1.end_minute;
    err = prefs_get_u32(SCHEDULE_NAMESPACE, "i_et", &u, schedule->ic_zone1.end_minute);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (u < 1440U) {
            schedule->ic_zone1.end_minute = (uint16_t)u;
        }
    } else {
        return err;
    }

    b = schedule->mister.enabled;
    err = prefs_get_bool(SCHEDULE_NAMESPACE, "m_en", &b, schedule->mister.enabled);
    if (err == ESP_OK || is_pref_missing(err)) {
        schedule->mister.enabled = b;
    } else {
        return err;
    }
    u = schedule->mister.start_minute;
    err = prefs_get_u32(SCHEDULE_NAMESPACE, "m_st", &u, schedule->mister.start_minute);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (u < 1440U) {
            schedule->mister.start_minute = (uint16_t)u;
        }
    } else {
        return err;
    }
    u = schedule->mister.end_minute;
    err = prefs_get_u32(SCHEDULE_NAMESPACE, "m_et", &u, schedule->mister.end_minute);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (u < 1440U) {
            schedule->mister.end_minute = (uint16_t)u;
        }
    } else {
        return err;
    }

    b = schedule->fan.enabled;
    err = prefs_get_bool(SCHEDULE_NAMESPACE, "f_en", &b, schedule->fan.enabled);
    if (err == ESP_OK || is_pref_missing(err)) {
        schedule->fan.enabled = b;
    } else {
        return err;
    }
    u = schedule->fan.start_minute;
    err = prefs_get_u32(SCHEDULE_NAMESPACE, "f_st", &u, schedule->fan.start_minute);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (u < 1440U) {
            schedule->fan.start_minute = (uint16_t)u;
        }
    } else {
        return err;
    }
    u = schedule->fan.end_minute;
    err = prefs_get_u32(SCHEDULE_NAMESPACE, "f_et", &u, schedule->fan.end_minute);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (u < 1440U) {
            schedule->fan.end_minute = (uint16_t)u;
        }
    } else {
        return err;
    }

    tz = schedule->timezone_offset_minutes;
    err = prefs_get_i32(SCHEDULE_NAMESPACE, "tz_ofs", &tz, schedule->timezone_offset_minutes);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (tz >= TZ_OFFSET_MIN && tz <= TZ_OFFSET_MAX) {
            schedule->timezone_offset_minutes = (int16_t)tz;
        }
    } else {
        return err;
    }

    updated_ms = schedule->updated_at_ms;
    err = prefs_get_u64(SCHEDULE_NAMESPACE, "upd_ms", &updated_ms, schedule->updated_at_ms);
    if (err == ESP_OK || is_pref_missing(err)) {
        schedule->updated_at_ms = updated_ms;
    } else {
        return err;
    }

    return ESP_OK;
}

static bool current_minute_of_day(int16_t timezone_offset_minutes, int *out_minute)
{
    if (!out_minute) {
        return false;
    }
    if (!time_sync_is_time_valid()) {
        return false;
    }

    struct timeval now;
    if (gettimeofday(&now, NULL) != 0) {
        return false;
    }

    int64_t local_minutes = ((int64_t)now.tv_sec / 60LL) + (int64_t)timezone_offset_minutes;
    int minute = (int)(local_minutes % 1440LL);
    if (minute < 0) {
        minute += 1440;
    }
    *out_minute = minute;
    return true;
}

static void apply_schedule_state(const node_schedule_t *schedule, int minute_of_day)
{
    bool desired_light = timer_is_active(&schedule->light, minute_of_day);
    if (!override_should_skip(&override_light) &&
        sensors_get_light_state() != desired_light) {
        sensors_set_light_state(desired_light);
    }

    bool desired_pump = timer_is_active(&schedule->pump, minute_of_day);
    if (!override_should_skip(&override_pump) &&
        sensors_get_pump_state() != desired_pump) {
        sensors_set_pump_state(desired_pump);
    }

    bool desired_ic_zone1 = timer_is_active(&schedule->ic_zone1, minute_of_day);
    if (!override_should_skip(&override_ic_zone1) &&
        sensors_get_ic_zone1_state() != desired_ic_zone1) {
        sensors_pulse_ic_zone1(desired_ic_zone1, IC_ZONE1_PULSE_MS);
        sensors_set_ic_zone1_state(desired_ic_zone1);
    }

    bool desired_mister = timer_is_active(&schedule->mister, minute_of_day);
    if (!override_should_skip(&override_mister) &&
        sensors_get_mister_state() != desired_mister) {
        sensors_set_mister_state(desired_mister);
    }

    bool desired_fan = timer_is_active(&schedule->fan, minute_of_day);
    if (!override_should_skip(&override_fan) &&
        sensors_get_fan_state() != desired_fan) {
        sensors_set_fan_state(desired_fan);
    }
}

static void apply_now_if_possible(void)
{
    node_schedule_t snapshot;
    int minute_of_day = 0;

    if (!schedule_initialized || !schedule_lock) {
        return;
    }

    if (xSemaphoreTake(schedule_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }
    snapshot = schedule_state;
    xSemaphoreGive(schedule_lock);

    if (!current_minute_of_day(snapshot.timezone_offset_minutes, &minute_of_day)) {
        return;
    }

    apply_schedule_state(&snapshot, minute_of_day);
}

esp_err_t node_schedule_init(void)
{
    if (schedule_initialized) {
        return ESP_OK;
    }

    schedule_lock = xSemaphoreCreateMutex();
    if (!schedule_lock) {
        return ESP_ERR_NO_MEM;
    }

    node_schedule_defaults(&schedule_state);
    esp_err_t err = load_schedule_locked(&schedule_state);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to load schedule from NVS: %s", esp_err_to_name(err));
        node_schedule_defaults(&schedule_state);
    }

    schedule_initialized = true;
    ESP_LOGI(
        TAG,
        "Schedule initialized (tzOffsetMin=%d updatedAtMs=%llu light=%d[%u-%u] pump=%d[%u-%u] ic1=%d[%u-%u] mister=%d[%u-%u] fan=%d[%u-%u])",
        (int)schedule_state.timezone_offset_minutes,
        (unsigned long long)schedule_state.updated_at_ms,
        schedule_state.light.enabled ? 1 : 0, (unsigned)schedule_state.light.start_minute, (unsigned)schedule_state.light.end_minute,
        schedule_state.pump.enabled ? 1 : 0, (unsigned)schedule_state.pump.start_minute, (unsigned)schedule_state.pump.end_minute,
        schedule_state.ic_zone1.enabled ? 1 : 0, (unsigned)schedule_state.ic_zone1.start_minute, (unsigned)schedule_state.ic_zone1.end_minute,
        schedule_state.mister.enabled ? 1 : 0, (unsigned)schedule_state.mister.start_minute, (unsigned)schedule_state.mister.end_minute,
        schedule_state.fan.enabled ? 1 : 0, (unsigned)schedule_state.fan.start_minute, (unsigned)schedule_state.fan.end_minute
    );

    apply_now_if_possible();
    return ESP_OK;
}

void node_schedule_get(node_schedule_t *out_schedule)
{
    if (!out_schedule) {
        return;
    }

    if (!schedule_initialized || !schedule_lock) {
        node_schedule_defaults(out_schedule);
        return;
    }

    if (xSemaphoreTake(schedule_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        node_schedule_defaults(out_schedule);
        return;
    }
    *out_schedule = schedule_state;
    xSemaphoreGive(schedule_lock);
}

esp_err_t node_schedule_set(const node_schedule_t *schedule)
{
    if (!schedule_initialized || !schedule_lock) {
        return ESP_ERR_INVALID_STATE;
    }
    if (!is_valid_schedule(schedule)) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(schedule_lock, pdMS_TO_TICKS(500)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    if (schedule_state.updated_at_ms > 0 &&
        schedule->updated_at_ms > 0 &&
        schedule->updated_at_ms < schedule_state.updated_at_ms) {
        xSemaphoreGive(schedule_lock);
        ESP_LOGW(TAG, "Ignoring stale schedule update (incoming=%llu current=%llu)",
                 (unsigned long long)schedule->updated_at_ms,
                 (unsigned long long)schedule_state.updated_at_ms);
        return ESP_ERR_INVALID_STATE;
    }

    schedule_state = *schedule;
    esp_err_t err = save_schedule_locked(&schedule_state);
    xSemaphoreGive(schedule_lock);

    if (err != ESP_OK) {
        return err;
    }

    ESP_LOGI(TAG, "Schedule updated and persisted");
    apply_now_if_possible();
    return ESP_OK;
}

void node_schedule_task(void *arg)
{
    (void)arg;

    while (true) {
        if (!schedule_initialized || !schedule_lock) {
            vTaskDelay(pdMS_TO_TICKS(SCHEDULE_TASK_PERIOD_MS));
            continue;
        }

        node_schedule_t snapshot;
        if (xSemaphoreTake(schedule_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
            vTaskDelay(pdMS_TO_TICKS(SCHEDULE_TASK_PERIOD_MS));
            continue;
        }
        snapshot = schedule_state;
        xSemaphoreGive(schedule_lock);

        int minute_of_day = 0;
        if (current_minute_of_day(snapshot.timezone_offset_minutes, &minute_of_day)) {
            apply_schedule_state(&snapshot, minute_of_day);
        }

        vTaskDelay(pdMS_TO_TICKS(SCHEDULE_TASK_PERIOD_MS));
    }
}

void node_schedule_set_override(node_schedule_target_t target, bool on, uint32_t duration_ms)
{
    schedule_override_t *ovr = override_for_target(target);
    if (!ovr) {
        return;
    }

    if (on) {
        uint32_t effective_duration_ms = override_duration_ms(duration_ms);
        ovr->active = true;
        ovr->expires_at_ms = monotonic_ms() + (uint64_t)effective_duration_ms;
        ESP_LOGI(TAG, "Manual override armed for %s; deferring schedule for %u ms (%u ms requested)",
                 target_name(target),
                 (unsigned)effective_duration_ms,
                 (unsigned)duration_ms);
        return;
    }

    ovr->active = false;
    ovr->expires_at_ms = 0;
    ESP_LOGI(TAG, "Manual override cleared for %s; reapplying schedule", target_name(target));
    apply_now_if_possible();
}
