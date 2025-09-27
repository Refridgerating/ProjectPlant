#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint64_t timestamp_ms;
    uint16_t soil_raw;
    float soil_percent;
    float temperature_c;
    float humidity_pct;
    bool water_low;
    bool pump_is_on;
} sensor_reading_t;

void sensors_init(void);
void sensors_collect(sensor_reading_t *out);
void sensors_set_pump_state(bool on);
bool sensors_get_pump_state(void);
