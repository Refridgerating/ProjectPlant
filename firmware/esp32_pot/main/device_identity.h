#pragma once

#include <stdbool.h>

#include "esp_err.h"

#define DEVICE_ID_MAX_LEN 32
#define DEVICE_NAME_MAX_LEN 32

typedef enum {
    SENSOR_MODE_FULL = 0,
    SENSOR_MODE_CONTROL_ONLY = 1,
} sensor_mode_t;

void device_identity_init(void);
const char *device_identity_id(void);
const char *device_identity_name(void);
bool device_identity_is_named(void);
esp_err_t device_identity_set_name(const char *name);
sensor_mode_t device_identity_sensor_mode(void);
const char *device_identity_sensor_mode_label(void);
bool device_identity_sensors_enabled(void);
esp_err_t device_identity_set_sensor_mode(sensor_mode_t mode);
