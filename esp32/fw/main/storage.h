#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#include "sensors.h"

typedef struct {
    sensor_reading_t reading;
    int64_t uptime_ms;
    int16_t rssi;
} telemetry_sample_t;

esp_err_t storage_init(void);
size_t storage_capacity(void);
size_t storage_count(void);
esp_err_t storage_append_sample(const telemetry_sample_t *sample);
bool storage_peek_oldest(telemetry_sample_t *out);
esp_err_t storage_drop_oldest(void);
