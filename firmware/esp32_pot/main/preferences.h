#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define PREFS_DEFAULT_NAMESPACE "app"

esp_err_t prefs_put_u8(const char *nvs_namespace, const char *key, uint8_t value);
esp_err_t prefs_get_u8(const char *nvs_namespace, const char *key, uint8_t *out_value, uint8_t default_value);

esp_err_t prefs_put_i32(const char *nvs_namespace, const char *key, int32_t value);
esp_err_t prefs_get_i32(const char *nvs_namespace, const char *key, int32_t *out_value, int32_t default_value);

esp_err_t prefs_put_u32(const char *nvs_namespace, const char *key, uint32_t value);
esp_err_t prefs_get_u32(const char *nvs_namespace, const char *key, uint32_t *out_value, uint32_t default_value);

esp_err_t prefs_put_bool(const char *nvs_namespace, const char *key, bool value);
esp_err_t prefs_get_bool(const char *nvs_namespace, const char *key, bool *out_value, bool default_value);

esp_err_t prefs_put_float(const char *nvs_namespace, const char *key, float value);
esp_err_t prefs_get_float(const char *nvs_namespace, const char *key, float *out_value, float default_value);

esp_err_t prefs_put_str(const char *nvs_namespace, const char *key, const char *value);
esp_err_t prefs_get_str(
    const char *nvs_namespace,
    const char *key,
    char *out_value,
    size_t out_value_len,
    const char *default_value);

esp_err_t prefs_put_blob(const char *nvs_namespace, const char *key, const void *value, size_t value_len);
esp_err_t prefs_get_blob(const char *nvs_namespace, const char *key, void *out_value, size_t *in_out_value_len);

esp_err_t put_char(const char *key, unsigned char value);
char get_char(const char *key, unsigned char default_value);
