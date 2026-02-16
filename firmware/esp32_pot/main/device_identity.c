#include "device_identity.h"

#include <stdio.h>
#include <stdint.h>
#include <string.h>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "nvs.h"

#include "hardware_config.h"

static const char *TAG = "identity";

static char device_id[DEVICE_ID_MAX_LEN];
static char device_name[DEVICE_NAME_MAX_LEN];
static bool device_named = false;
static sensor_mode_t sensor_mode = SENSOR_MODE_FULL;
static bool identity_ready = false;

static void generate_default_name(const uint8_t *mac)
{
    snprintf(device_name, sizeof(device_name), "%s-%02X%02X%02X",
             DEVICE_NAME_PREFIX,
             mac[3], mac[4], mac[5]);
}

void device_identity_init(void)
{
    uint8_t mac[6] = {0};
    esp_efuse_mac_get_default(mac);

    snprintf(device_id, sizeof(device_id),
             "%s-%02x%02x%02x%02x%02x%02x",
             DEVICE_ID_PREFIX,
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    device_name[0] = '\0';
    device_named = false;
    sensor_mode = SENSOR_MODE_FULL;

    nvs_handle_t handle;
    esp_err_t err = nvs_open("device", NVS_READWRITE, &handle);
    if (err == ESP_OK) {
        size_t len = sizeof(device_name);
        err = nvs_get_str(handle, "display_name", device_name, &len);
        if (err == ESP_OK && device_name[0]) {
            device_named = true;
        } else {
            generate_default_name(mac);
        }

        uint8_t stored_mode = 0;
        err = nvs_get_u8(handle, "sensor_mode", &stored_mode);
        if (err == ESP_OK) {
            sensor_mode = stored_mode == SENSOR_MODE_CONTROL_ONLY ? SENSOR_MODE_CONTROL_ONLY : SENSOR_MODE_FULL;
        }
        nvs_close(handle);
    } else {
        ESP_LOGW(TAG, "NVS open failed (%s); using default name", esp_err_to_name(err));
        generate_default_name(mac);
    }

    identity_ready = true;
    ESP_LOGI(TAG, "Device identity: id=%s name=%s named=%s",
             device_id,
             device_name,
             device_named ? "true" : "false");
    ESP_LOGI(TAG, "Sensor mode: %s", sensor_mode == SENSOR_MODE_CONTROL_ONLY ? "control_only" : "full");
}

const char *device_identity_id(void)
{
    if (!identity_ready) {
        return "";
    }
    return device_id;
}

const char *device_identity_name(void)
{
    if (!identity_ready) {
        return "";
    }
    return device_name;
}

bool device_identity_is_named(void)
{
    return identity_ready && device_named;
}

esp_err_t device_identity_set_name(const char *name)
{
    if (!name) {
        return ESP_ERR_INVALID_ARG;
    }

    size_t len = strnlen(name, DEVICE_NAME_MAX_LEN);
    if (len == 0 || len >= DEVICE_NAME_MAX_LEN) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open("device", NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_set_str(handle, "display_name", name);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);

    if (err == ESP_OK) {
        memcpy(device_name, name, len);
        device_name[len] = '\0';
        device_named = true;
        ESP_LOGI(TAG, "Display name updated to %s", device_name);
    }

    return err;
}

sensor_mode_t device_identity_sensor_mode(void)
{
    return sensor_mode;
}

const char *device_identity_sensor_mode_label(void)
{
    return sensor_mode == SENSOR_MODE_CONTROL_ONLY ? "control_only" : "full";
}

bool device_identity_sensors_enabled(void)
{
    return sensor_mode == SENSOR_MODE_FULL;
}

esp_err_t device_identity_set_sensor_mode(sensor_mode_t mode)
{
    if (mode != SENSOR_MODE_FULL && mode != SENSOR_MODE_CONTROL_ONLY) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open("device", NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_set_u8(handle, "sensor_mode", (uint8_t)mode);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);

    if (err == ESP_OK) {
        sensor_mode = mode;
        ESP_LOGI(TAG, "Sensor mode updated to %s", device_identity_sensor_mode_label());
    }

    return err;
}
