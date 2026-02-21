#pragma once

#include <stdbool.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define STARTUP_MQTT_URI_MAX_LEN 128
#define STARTUP_HUB_URL_MAX_LEN 128

typedef struct {
    bool factory_default;
    bool provisioning_started;
    bool wifi_connected;
    bool ble_transport;
    char mqtt_uri[STARTUP_MQTT_URI_MAX_LEN];
    char hub_url[STARTUP_HUB_URL_MAX_LEN];
} startup_onboarding_state_t;

esp_err_t startup_onboarding_run(
    const char *device_id,
    const char *default_mqtt_uri,
    const char *fallback_ssid,
    const char *fallback_password,
    startup_onboarding_state_t *out_state);

#ifdef __cplusplus
}
#endif
