#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool enabled;
    uint16_t start_minute;
    uint16_t end_minute;
} node_schedule_timer_t;

#define NODE_SCHEDULE_TIMEZONE_POSIX_MAX_LEN 96

typedef struct {
    node_schedule_timer_t light;
    node_schedule_timer_t pump;
    node_schedule_timer_t ic_zone1;
    node_schedule_timer_t mister;
    node_schedule_timer_t fan;
    int16_t timezone_offset_minutes;
    char timezone_posix[NODE_SCHEDULE_TIMEZONE_POSIX_MAX_LEN];
    uint64_t updated_at_ms;
} node_schedule_t;

typedef enum {
    NODE_SCHEDULE_TARGET_LIGHT = 0,
    NODE_SCHEDULE_TARGET_PUMP,
    NODE_SCHEDULE_TARGET_IC_ZONE1,
    NODE_SCHEDULE_TARGET_MISTER,
    NODE_SCHEDULE_TARGET_FAN,
    NODE_SCHEDULE_TARGET_COUNT,
} node_schedule_target_t;

void node_schedule_defaults(node_schedule_t *out_schedule);
bool node_schedule_parse_hhmm(const char *value, uint16_t *out_minutes);
bool node_schedule_minute_of_day_from_epoch(const node_schedule_t *schedule, int64_t epoch_seconds, int *out_minute);
esp_err_t node_schedule_init(void);
esp_err_t node_schedule_set(const node_schedule_t *schedule);
void node_schedule_get(node_schedule_t *out_schedule);
void node_schedule_task(void *arg);
uint32_t node_schedule_set_override(node_schedule_target_t target, bool on, uint32_t duration_ms);
esp_err_t node_schedule_set_snooze(bool active, uint32_t duration_ms, uint64_t *out_until_epoch_ms);
bool node_schedule_get_snooze_state(uint64_t *out_until_epoch_ms);
uint32_t node_schedule_get_snooze_remaining_ms(void);

#ifdef __cplusplus
}
#endif
