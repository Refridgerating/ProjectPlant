#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint64_t timestamp_ms;
    uint16_t soil_raw;
    float soil_percent;
    float temperature_c;
    float humidity_pct;
    bool water_low;      // Backwards-compatible: maps to refill float
    bool water_cutoff;   // New: cutoff float (active-low)
    bool pump_is_on;
    bool fan_is_on;
    bool mister_is_on;
} sensor_reading_t;

void sensors_init(void);
void sensors_collect(sensor_reading_t *out);
void sensors_set_pump_state(bool on);
bool sensors_get_pump_state(void);
void sensors_set_fan_state(bool on);
bool sensors_get_fan_state(void);
void sensors_set_mister_state(bool on);
bool sensors_get_mister_state(void);
