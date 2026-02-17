#include "preferences.h"
#include "nvs_flash.h"
#include "nvs.h"

esp_err_t put_char(const char *key, unsigned char value) {
    nvs_handle_t h;
    esp_err_t err = nvs_open("app", NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_u8(h, key, (uint8_t)value);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

char get_char(const char *key, unsigned char default_value) {
    nvs_handle_t h;
    uint8_t v = (uint8_t)default_value;
    if (nvs_open("app", NVS_READONLY, &h) != ESP_OK) return default_value;
    if (nvs_get_u8(h, key, &v) != ESP_OK) v = (uint8_t)default_value;
    nvs_close(h);
    return (char)v;
}
