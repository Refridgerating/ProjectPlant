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

typedef struct {
    node_schedule_timer_t light;
    node_schedule_timer_t pump;
    node_schedule_timer_t mister;
    node_schedule_timer_t fan;
    int16_t timezone_offset_minutes;
} node_schedule_t;

void node_schedule_defaults(node_schedule_t *out_schedule);
bool node_schedule_parse_hhmm(const char *value, uint16_t *out_minutes);
esp_err_t node_schedule_init(void);
esp_err_t node_schedule_set(const node_schedule_t *schedule);
void node_schedule_get(node_schedule_t *out_schedule);
void node_schedule_task(void *arg);

#ifdef __cplusplus
}
#endif
