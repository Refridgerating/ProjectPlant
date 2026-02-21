#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include <mqtt_client.h>

#include "device_identity.h"
#include "node_schedule.h"
#include "sensors.h"

typedef enum {
    MQTT_CMD_UNKNOWN = 0,
    MQTT_CMD_PUMP_OVERRIDE,
    MQTT_CMD_CONFIG_UPDATE,
    MQTT_CMD_SENSOR_READ,
    MQTT_CMD_FAN_OVERRIDE,
    MQTT_CMD_MISTER_OVERRIDE,
    MQTT_CMD_LIGHT_OVERRIDE,
} mqtt_command_type_t;

#define MQTT_REQUEST_ID_MAX_LEN 64

typedef struct {
    mqtt_command_type_t type;
    char request_id[MQTT_REQUEST_ID_MAX_LEN];
    char device_name[DEVICE_NAME_MAX_LEN];
    bool has_sensor_mode;
    bool has_schedule;
    sensor_mode_t sensor_mode;
    node_schedule_t schedule;
    bool pump_on;
    bool fan_on;
    bool mister_on;
    bool light_on;
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
                          const sensor_reading_t *reading,
                          const char *request_id);

void mqtt_publish_status(esp_mqtt_client_handle_t client,
                         const char *device_id,
                         const char *version,
                         const char *status,
                         const char *request_id);

void mqtt_publish_ping(esp_mqtt_client_handle_t client,
                       const char *device_id);

mqtt_command_t mqtt_parse_command(const char *payload, int payload_len);
