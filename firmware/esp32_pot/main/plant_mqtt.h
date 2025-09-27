#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include <mqtt_client.h>

#include "sensors.h"

typedef enum {
    MQTT_CMD_UNKNOWN = 0,
    MQTT_CMD_PUMP_OVERRIDE,
    MQTT_CMD_CONFIG_UPDATE,
} mqtt_command_type_t;

typedef struct {
    mqtt_command_type_t type;
    bool pump_on;
    uint32_t duration_ms;
} mqtt_command_t;

typedef void (*mqtt_command_callback_t)(const mqtt_command_t *cmd);

esp_mqtt_client_handle_t mqtt_client_start(const char *uri,
                                           const char *device_id,
                                           const char *username,
                                           const char *password,
                                           mqtt_command_callback_t cb);

void mqtt_publish_reading(esp_mqtt_client_handle_t client,
                          const char *device_id,
                          const sensor_reading_t *reading);

void mqtt_publish_status(esp_mqtt_client_handle_t client,
                         const char *device_id,
                         const char *version,
                         const char *status);

mqtt_command_t mqtt_parse_command(const char *payload, int payload_len);
