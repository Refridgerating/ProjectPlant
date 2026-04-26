#include "node_schedule.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

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
#define SCHEDULE_SNOOZE_ACTIVE_KEY "snooze_on"
#define SCHEDULE_SNOOZE_UNTIL_KEY  "snooze_ms"

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

typedef struct {
    bool active;
    uint64_t until_epoch_ms;
} schedule_snooze_t;

static schedule_override_t override_light = {0};
static schedule_override_t override_pump = {0};
static schedule_override_t override_ic_zone1 = {0};
static schedule_override_t override_mister = {0};
static schedule_override_t override_fan = {0};
static schedule_snooze_t schedule_snooze = {0};

static const node_schedule_timer_t DEFAULT_LIGHT = { .enabled = false, .start_minute = 6 * 60, .end_minute = 20 * 60 };
static const node_schedule_timer_t DEFAULT_PUMP = { .enabled = false, .start_minute = 7 * 60, .end_minute = (7 * 60) + 15 };
static const node_schedule_timer_t DEFAULT_IC_ZONE1 = { .enabled = false, .start_minute = 7 * 60, .end_minute = (7 * 60) + 15 };
static const node_schedule_timer_t DEFAULT_MISTER = { .enabled = false, .start_minute = 8 * 60, .end_minute = (8 * 60) + 15 };
static const node_schedule_timer_t DEFAULT_FAN = { .enabled = false, .start_minute = 9 * 60, .end_minute = 18 * 60 };

typedef struct {
    int month;
    int week;
    int weekday;
    int seconds_of_day;
} posix_rule_t;

typedef struct {
    bool has_dst;
    int32_t std_offset_seconds;
    int32_t dst_offset_seconds;
    posix_rule_t start_rule;
    posix_rule_t end_rule;
} posix_timezone_t;

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

static size_t timezone_posix_length(const char *value)
{
    if (!value) {
        return 0;
    }
    return strnlen(value, NODE_SCHEDULE_TIMEZONE_POSIX_MAX_LEN);
}

static bool is_valid_timezone_posix(const char *value)
{
    size_t length = timezone_posix_length(value);
    if (length == 0) {
        return true;
    }
    if (length >= NODE_SCHEDULE_TIMEZONE_POSIX_MAX_LEN) {
        return false;
    }

    for (size_t i = 0; i < length; ++i) {
        unsigned char c = (unsigned char)value[i];
        if (c < 32U || c > 126U) {
            return false;
        }
    }
    return true;
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
           schedule->timezone_offset_minutes <= TZ_OFFSET_MAX &&
           is_valid_timezone_posix(schedule->timezone_posix);
}

static uint64_t monotonic_ms(void)
{
    return (uint64_t)(esp_timer_get_time() / 1000ULL);
}

static bool current_epoch_ms(uint64_t *out_epoch_ms)
{
    if (!out_epoch_ms) {
        return false;
    }
    if (!time_sync_is_time_valid()) {
        return false;
    }

    struct timeval now;
    if (gettimeofday(&now, NULL) != 0) {
        return false;
    }

    *out_epoch_ms = ((uint64_t)now.tv_sec * 1000ULL) + ((uint64_t)now.tv_usec / 1000ULL);
    return true;
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

static esp_err_t save_snooze_locked(const schedule_snooze_t *snooze)
{
    if (!snooze) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t err = prefs_put_bool(SCHEDULE_NAMESPACE, SCHEDULE_SNOOZE_ACTIVE_KEY, snooze->active);
    if (err != ESP_OK) {
        return err;
    }
    return prefs_put_u64(SCHEDULE_NAMESPACE, SCHEDULE_SNOOZE_UNTIL_KEY, snooze->until_epoch_ms);
}

static esp_err_t load_snooze_locked(schedule_snooze_t *snooze)
{
    if (!snooze) {
        return ESP_ERR_INVALID_ARG;
    }

    snooze->active = false;
    snooze->until_epoch_ms = 0;

    bool active = false;
    esp_err_t err = prefs_get_bool(SCHEDULE_NAMESPACE, SCHEDULE_SNOOZE_ACTIVE_KEY, &active, false);
    if (err != ESP_OK && !is_pref_missing(err)) {
        return err;
    }

    uint64_t until_epoch_ms = 0;
    err = prefs_get_u64(SCHEDULE_NAMESPACE, SCHEDULE_SNOOZE_UNTIL_KEY, &until_epoch_ms, 0);
    if (err != ESP_OK && !is_pref_missing(err)) {
        return err;
    }

    snooze->active = active;
    snooze->until_epoch_ms = until_epoch_ms;
    return ESP_OK;
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
    out_schedule->timezone_posix[0] = '\0';
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

static bool parse_positive_int(const char **cursor, int *out_value)
{
    if (!cursor || !*cursor || !out_value) {
        return false;
    }
    const char *p = *cursor;
    if (*p < '0' || *p > '9') {
        return false;
    }

    int value = 0;
    while (*p >= '0' && *p <= '9') {
        value = (value * 10) + (*p - '0');
        ++p;
    }

    *cursor = p;
    *out_value = value;
    return true;
}

static bool parse_posix_offset_seconds(const char **cursor, int32_t *out_offset_seconds)
{
    if (!cursor || !*cursor || !out_offset_seconds) {
        return false;
    }

    const char *p = *cursor;
    int sign = 1;
    if (*p == '+') {
        ++p;
    } else if (*p == '-') {
        sign = -1;
        ++p;
    }

    int hour = 0;
    if (!parse_positive_int(&p, &hour)) {
        return false;
    }

    int minute = 0;
    int second = 0;
    if (*p == ':') {
        ++p;
        if (!parse_positive_int(&p, &minute)) {
            return false;
        }
        if (*p == ':') {
            ++p;
            if (!parse_positive_int(&p, &second)) {
                return false;
            }
        }
    }

    int32_t raw_offset_seconds = (int32_t)((hour * 3600) + (minute * 60) + second);
    raw_offset_seconds *= sign;
    *cursor = p;
    *out_offset_seconds = -raw_offset_seconds;
    return true;
}

static bool parse_posix_rule(const char **cursor, posix_rule_t *out_rule)
{
    if (!cursor || !*cursor || !out_rule) {
        return false;
    }

    const char *p = *cursor;
    if (*p != 'M') {
        return false;
    }
    ++p;

    int month = 0;
    int week = 0;
    int weekday = 0;
    int seconds_of_day = 2 * 3600;

    if (!parse_positive_int(&p, &month) || *p != '.') {
        return false;
    }
    ++p;
    if (!parse_positive_int(&p, &week) || *p != '.') {
        return false;
    }
    ++p;
    if (!parse_positive_int(&p, &weekday)) {
        return false;
    }

    if (*p == '/') {
        ++p;
        if (!parse_positive_int(&p, &seconds_of_day)) {
            return false;
        }
        if (*p == ':') {
            ++p;
            int minute = 0;
            if (!parse_positive_int(&p, &minute)) {
                return false;
            }
            seconds_of_day = (seconds_of_day * 3600) + (minute * 60);
            if (*p == ':') {
                ++p;
                int second = 0;
                if (!parse_positive_int(&p, &second)) {
                    return false;
                }
                seconds_of_day += second;
            }
        } else {
            seconds_of_day *= 3600;
        }
    }

    if (month < 1 || month > 12 || week < 1 || week > 5 || weekday < 0 || weekday > 6) {
        return false;
    }

    out_rule->month = month;
    out_rule->week = week;
    out_rule->weekday = weekday;
    out_rule->seconds_of_day = seconds_of_day;
    *cursor = p;
    return true;
}

static bool parse_posix_timezone(const char *value, posix_timezone_t *out_timezone)
{
    if (!value || !value[0] || !out_timezone) {
        return false;
    }

    const char *p = value;
    while ((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z')) {
        ++p;
    }
    if (p == value) {
        return false;
    }

    int32_t std_offset_seconds = 0;
    if (!parse_posix_offset_seconds(&p, &std_offset_seconds)) {
        return false;
    }

    posix_timezone_t parsed = {
        .has_dst = false,
        .std_offset_seconds = std_offset_seconds,
        .dst_offset_seconds = std_offset_seconds + 3600,
    };

    const char *dst_name = p;
    while ((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z')) {
        ++p;
    }
    if (p != dst_name) {
        parsed.has_dst = true;
        if (*p != ',' && *p != '\0') {
            if (!parse_posix_offset_seconds(&p, &parsed.dst_offset_seconds)) {
                return false;
            }
        }
        if (*p != ',') {
            return false;
        }
        ++p;
        if (!parse_posix_rule(&p, &parsed.start_rule) || *p != ',') {
            return false;
        }
        ++p;
        if (!parse_posix_rule(&p, &parsed.end_rule)) {
            return false;
        }
    }

    if (*p != '\0') {
        return false;
    }

    *out_timezone = parsed;
    return true;
}

static int64_t days_from_civil(int year, unsigned month, unsigned day)
{
    year -= month <= 2U;
    const int era = (year >= 0 ? year : year - 399) / 400;
    const unsigned yoe = (unsigned)(year - (era * 400));
    const int month_index = (int)month + (month > 2U ? -3 : 9);
    const unsigned doy = (unsigned)(((153 * month_index) + 2) / 5) + day - 1U;
    const unsigned doe = yoe * 365U + yoe / 4U - yoe / 100U + doy;
    return (int64_t)(era * 146097) + (int64_t)doe - 719468LL;
}

static int days_in_month(int year, int month)
{
    static const int DAYS_PER_MONTH[12] = {
        31, 28, 31, 30, 31, 30,
        31, 31, 30, 31, 30, 31,
    };
    int days = DAYS_PER_MONTH[month - 1];
    if (month == 2) {
        bool leap = ((year % 4) == 0 && (year % 100) != 0) || ((year % 400) == 0);
        if (leap) {
            days = 29;
        }
    }
    return days;
}

static int weekday_from_days(int64_t days_since_epoch)
{
    int weekday = (int)((days_since_epoch + 4LL) % 7LL);
    if (weekday < 0) {
        weekday += 7;
    }
    return weekday;
}

static int day_of_month_for_rule(int year, const posix_rule_t *rule)
{
    int first_weekday = weekday_from_days(days_from_civil(year, (unsigned)rule->month, 1U));
    int day = 1 + ((rule->weekday - first_weekday + 7) % 7) + ((rule->week - 1) * 7);
    int max_day = days_in_month(year, rule->month);
    if (day > max_day) {
        day -= 7;
    }
    return day;
}

static int year_from_epoch_seconds(int64_t epoch_seconds)
{
    time_t time_value = (time_t)epoch_seconds;
    struct tm tm_utc;
    if (gmtime_r(&time_value, &tm_utc) == NULL) {
        return 1970;
    }
    return tm_utc.tm_year + 1900;
}

static int64_t transition_utc_epoch(int year, const posix_rule_t *rule, int32_t offset_before_seconds)
{
    int day = day_of_month_for_rule(year, rule);
    int64_t local_seconds = (days_from_civil(year, (unsigned)rule->month, (unsigned)day) * 86400LL) + rule->seconds_of_day;
    return local_seconds - (int64_t)offset_before_seconds;
}

static bool is_dst_active_for_epoch(const posix_timezone_t *timezone, int64_t epoch_seconds)
{
    if (!timezone || !timezone->has_dst) {
        return false;
    }

    int year = year_from_epoch_seconds(epoch_seconds);
    int64_t start_utc = transition_utc_epoch(year, &timezone->start_rule, timezone->std_offset_seconds);
    int64_t end_utc = transition_utc_epoch(year, &timezone->end_rule, timezone->dst_offset_seconds);

    if (start_utc < end_utc) {
        return epoch_seconds >= start_utc && epoch_seconds < end_utc;
    }
    return epoch_seconds >= start_utc || epoch_seconds < end_utc;
}

static bool minute_of_day_from_fixed_offset(int16_t timezone_offset_minutes, int64_t epoch_seconds, int *out_minute)
{
    if (!out_minute) {
        return false;
    }

    int64_t local_minutes = (epoch_seconds / 60LL) + (int64_t)timezone_offset_minutes;
    int minute = (int)(local_minutes % 1440LL);
    if (minute < 0) {
        minute += 1440;
    }
    *out_minute = minute;
    return true;
}

bool node_schedule_minute_of_day_from_epoch(const node_schedule_t *schedule, int64_t epoch_seconds, int *out_minute)
{
    if (!schedule || !out_minute) {
        return false;
    }

    if (schedule->timezone_posix[0] != '\0') {
        posix_timezone_t timezone;
        if (parse_posix_timezone(schedule->timezone_posix, &timezone)) {
            int32_t offset_seconds = timezone.std_offset_seconds;
            if (is_dst_active_for_epoch(&timezone, epoch_seconds)) {
                offset_seconds = timezone.dst_offset_seconds;
            }
            return minute_of_day_from_fixed_offset((int16_t)(offset_seconds / 60), epoch_seconds, out_minute);
        }
    }

    return minute_of_day_from_fixed_offset(schedule->timezone_offset_minutes, epoch_seconds, out_minute);
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

    err = prefs_put_str(SCHEDULE_NAMESPACE, "tz_posix", schedule->timezone_posix);
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
    char timezone_posix[NODE_SCHEDULE_TIMEZONE_POSIX_MAX_LEN] = {0};

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

    err = prefs_get_str(
        SCHEDULE_NAMESPACE,
        "tz_posix",
        timezone_posix,
        sizeof(timezone_posix),
        schedule->timezone_posix);
    if (err == ESP_OK || is_pref_missing(err)) {
        if (is_valid_timezone_posix(timezone_posix)) {
            strncpy(schedule->timezone_posix, timezone_posix, sizeof(schedule->timezone_posix) - 1);
            schedule->timezone_posix[sizeof(schedule->timezone_posix) - 1] = '\0';
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

static bool current_minute_of_day(const node_schedule_t *schedule, int *out_minute)
{
    if (!schedule || !out_minute) {
        return false;
    }
    if (!time_sync_is_time_valid()) {
        return false;
    }

    struct timeval now;
    if (gettimeofday(&now, NULL) != 0) {
        return false;
    }

    if (schedule->timezone_posix[0] != '\0') {
        time_t time_value = (time_t)now.tv_sec;
        struct tm local_tm;
        if (localtime_r(&time_value, &local_tm) == NULL) {
            return false;
        }
        *out_minute = (local_tm.tm_hour * 60) + local_tm.tm_min;
        return true;
    }

    return minute_of_day_from_fixed_offset(schedule->timezone_offset_minutes, (int64_t)now.tv_sec, out_minute);
}

static void apply_snooze_state(void)
{
    if (!override_should_skip(&override_light) &&
        sensors_get_light_state()) {
        sensors_set_light_state(false);
    }

    if (!override_should_skip(&override_pump) &&
        sensors_get_pump_state()) {
        sensors_set_pump_state(false);
    }

    if (!override_should_skip(&override_ic_zone1) &&
        sensors_get_ic_zone1_state()) {
        sensors_pulse_ic_zone1(false, IC_ZONE1_PULSE_MS);
        sensors_set_ic_zone1_state(false);
    }

    if (!override_should_skip(&override_mister) &&
        sensors_get_mister_state()) {
        sensors_set_mister_state(false);
    }

    if (!override_should_skip(&override_fan) &&
        sensors_get_fan_state()) {
        sensors_set_fan_state(false);
    }
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
    bool snooze_active = false;
    int minute_of_day = 0;

    if (!schedule_initialized || !schedule_lock) {
        return;
    }

    if (xSemaphoreTake(schedule_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        return;
    }
    snapshot = schedule_state;
    snooze_active = schedule_snooze.active;
    xSemaphoreGive(schedule_lock);

    if (snooze_active) {
        apply_snooze_state();
        return;
    }

    if (!current_minute_of_day(&snapshot, &minute_of_day)) {
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
    err = load_snooze_locked(&schedule_snooze);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to load schedule snooze from NVS: %s", esp_err_to_name(err));
        schedule_snooze.active = false;
        schedule_snooze.until_epoch_ms = 0;
    }

    schedule_initialized = true;
    if (schedule_state.timezone_posix[0] != '\0') {
        esp_err_t timezone_err = time_sync_set_timezone(schedule_state.timezone_posix);
        if (timezone_err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to apply persisted schedule timezone: %s", esp_err_to_name(timezone_err));
        }
    }
    ESP_LOGI(
        TAG,
        "Schedule initialized (tzOffsetMin=%d tzPosix=%s updatedAtMs=%llu snooze=%d until=%llu light=%d[%u-%u] pump=%d[%u-%u] ic1=%d[%u-%u] mister=%d[%u-%u] fan=%d[%u-%u])",
        (int)schedule_state.timezone_offset_minutes,
        schedule_state.timezone_posix[0] ? schedule_state.timezone_posix : "<none>",
        (unsigned long long)schedule_state.updated_at_ms,
        schedule_snooze.active ? 1 : 0,
        (unsigned long long)schedule_snooze.until_epoch_ms,
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
    esp_err_t timezone_err = time_sync_set_timezone(
        schedule_state.timezone_posix[0] ? schedule_state.timezone_posix : NULL);
    if (timezone_err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to apply schedule timezone: %s", esp_err_to_name(timezone_err));
    }
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
        apply_now_if_possible();
        vTaskDelay(pdMS_TO_TICKS(SCHEDULE_TASK_PERIOD_MS));
    }
}

uint32_t node_schedule_set_override(node_schedule_target_t target, bool on, uint32_t duration_ms)
{
    schedule_override_t *ovr = override_for_target(target);
    if (!ovr) {
        return 0;
    }

    if (on) {
        uint32_t effective_duration_ms = override_duration_ms(duration_ms);
        ovr->active = true;
        ovr->expires_at_ms = monotonic_ms() + (uint64_t)effective_duration_ms;
        ESP_LOGI(TAG, "Manual override armed for %s; deferring schedule for %u ms (%u ms requested)",
                 target_name(target),
                 (unsigned)effective_duration_ms,
                 (unsigned)duration_ms);
        return effective_duration_ms;
    }

    ovr->active = false;
    ovr->expires_at_ms = 0;
    ESP_LOGI(TAG, "Manual override cleared for %s; reapplying schedule", target_name(target));
    apply_now_if_possible();
    return 0;
}

esp_err_t node_schedule_set_snooze(bool active, uint32_t duration_ms, uint64_t *out_until_epoch_ms)
{
    if (out_until_epoch_ms) {
        *out_until_epoch_ms = 0;
    }

    if (!schedule_initialized || !schedule_lock) {
        return ESP_ERR_INVALID_STATE;
    }

    uint64_t until_epoch_ms = 0;
    uint32_t effective_duration_ms = duration_ms > 0 ? duration_ms : SCHEDULE_SNOOZE_DURATION_MS;

    if (xSemaphoreTake(schedule_lock, pdMS_TO_TICKS(500)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    schedule_snooze_t previous_snooze = schedule_snooze;

    if (active) {
        uint64_t now_epoch_ms = 0;
        if (current_epoch_ms(&now_epoch_ms)) {
            until_epoch_ms = now_epoch_ms + (uint64_t)effective_duration_ms;
        }
        schedule_snooze.active = true;
        schedule_snooze.until_epoch_ms = until_epoch_ms;
    } else {
        schedule_snooze.active = false;
        schedule_snooze.until_epoch_ms = 0;
    }

    esp_err_t err = save_snooze_locked(&schedule_snooze);
    if (err != ESP_OK) {
        schedule_snooze = previous_snooze;
    }
    xSemaphoreGive(schedule_lock);
    if (err != ESP_OK) {
        return err;
    }

    if (out_until_epoch_ms) {
        *out_until_epoch_ms = until_epoch_ms;
    }

    if (active) {
        if (until_epoch_ms > 0) {
            ESP_LOGI(TAG, "Schedule snooze armed for %u ms until %llu",
                     (unsigned)effective_duration_ms,
                     (unsigned long long)until_epoch_ms);
        } else {
            ESP_LOGW(TAG, "Schedule snooze armed for %u ms without a synced wall clock; reboot restore will fall back to the default snooze duration",
                     (unsigned)effective_duration_ms);
        }
        apply_snooze_state();
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Schedule snooze cleared; reapplying schedule");
    apply_now_if_possible();
    return ESP_OK;
}

bool node_schedule_get_snooze_state(uint64_t *out_until_epoch_ms)
{
    bool active = false;
    uint64_t until_epoch_ms = 0;

    if (!schedule_initialized || !schedule_lock) {
        if (out_until_epoch_ms) {
            *out_until_epoch_ms = 0;
        }
        return false;
    }

    if (xSemaphoreTake(schedule_lock, pdMS_TO_TICKS(100)) != pdTRUE) {
        if (out_until_epoch_ms) {
            *out_until_epoch_ms = 0;
        }
        return false;
    }
    active = schedule_snooze.active;
    until_epoch_ms = schedule_snooze.until_epoch_ms;
    xSemaphoreGive(schedule_lock);

    if (out_until_epoch_ms) {
        *out_until_epoch_ms = active ? until_epoch_ms : 0;
    }
    return active;
}

uint32_t node_schedule_get_snooze_remaining_ms(void)
{
    uint64_t until_epoch_ms = 0;
    if (!node_schedule_get_snooze_state(&until_epoch_ms)) {
        return 0;
    }

    uint64_t now_epoch_ms = 0;
    if (!current_epoch_ms(&now_epoch_ms) || until_epoch_ms == 0) {
        return SCHEDULE_SNOOZE_DURATION_MS;
    }
    if (now_epoch_ms >= until_epoch_ms) {
        return 0;
    }

    uint64_t remaining_ms = until_epoch_ms - now_epoch_ms;
    if (remaining_ms > UINT32_MAX) {
        return UINT32_MAX;
    }
    return (uint32_t)remaining_ms;
}
