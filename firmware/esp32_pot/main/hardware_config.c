#include <stddef.h>

#include "hardware_config.h"

// Safe defaults for repo; override by adding hardware_config.local.c (git-ignored).
const char *WIFI_SSID = "";
const char *WIFI_PASS = "";

const char *MQTT_BROKER_URI = "mqtt://192.168.0.15:1883";
const char *MQTT_USERNAME = NULL;
const char *MQTT_PASSWORD = NULL;
