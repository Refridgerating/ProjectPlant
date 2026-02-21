#include "preferences.h"

#include <string.h>

#include "nvs.h"

static const char *resolve_namespace(const char *nvs_namespace)
{
    if (nvs_namespace && nvs_namespace[0] != '\0') {
        return nvs_namespace;
    }
    return PREFS_DEFAULT_NAMESPACE;
}

static esp_err_t commit_and_close(nvs_handle_t handle, esp_err_t err)
{
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

static void copy_default_str(char *out_value, size_t out_value_len, const char *default_value)
{
    if (!out_value || out_value_len == 0) {
        return;
    }

    if (!default_value) {
        out_value[0] = '\0';
        return;
    }

    size_t copy_len = 0;
    while ((copy_len + 1) < out_value_len && default_value[copy_len] != '\0') {
        copy_len++;
    }
    memcpy(out_value, default_value, copy_len);
    out_value[copy_len] = '\0';
}

esp_err_t prefs_put_u8(const char *nvs_namespace, const char *key, uint8_t value)
{
    if (!key) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(resolve_namespace(nvs_namespace), NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_set_u8(handle, key, value);
    return commit_and_close(handle, err);
}

esp_err_t prefs_get_u8(const char *nvs_namespace, const char *key, uint8_t *out_value, uint8_t default_value)
{
    if (!key || !out_value) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(resolve_namespace(nvs_namespace), NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return err;
    }

    uint8_t value = default_value;
    err = nvs_get_u8(handle, key, &value);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        err = ESP_OK;
    }
    nvs_close(handle);

    if (err == ESP_OK) {
        *out_value = value;
    }
    return err;
}

esp_err_t prefs_put_i32(const char *nvs_namespace, const char *key, int32_t value)
{
    if (!key) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(resolve_namespace(nvs_namespace), NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_set_i32(handle, key, value);
    return commit_and_close(handle, err);
}

esp_err_t prefs_get_i32(const char *nvs_namespace, const char *key, int32_t *out_value, int32_t default_value)
{
    if (!key || !out_value) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(resolve_namespace(nvs_namespace), NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return err;
    }

    int32_t value = default_value;
    err = nvs_get_i32(handle, key, &value);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        err = ESP_OK;
    }
    nvs_close(handle);

    if (err == ESP_OK) {
        *out_value = value;
    }
    return err;
}

esp_err_t prefs_put_u32(const char *nvs_namespace, const char *key, uint32_t value)
{
    if (!key) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(resolve_namespace(nvs_namespace), NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_set_u32(handle, key, value);
    return commit_and_close(handle, err);
}

esp_err_t prefs_get_u32(const char *nvs_namespace, const char *key, uint32_t *out_value, uint32_t default_value)
{
    if (!key || !out_value) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(resolve_namespace(nvs_namespace), NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return err;
    }

    uint32_t value = default_value;
    err = nvs_get_u32(handle, key, &value);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        err = ESP_OK;
    }
    nvs_close(handle);

    if (err == ESP_OK) {
        *out_value = value;
    }
    return err;
}

esp_err_t prefs_put_bool(const char *nvs_namespace, const char *key, bool value)
{
    return prefs_put_u8(nvs_namespace, key, value ? 1U : 0U);
}

esp_err_t prefs_get_bool(const char *nvs_namespace, const char *key, bool *out_value, bool default_value)
{
    if (!out_value) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t raw = default_value ? 1U : 0U;
    esp_err_t err = prefs_get_u8(nvs_namespace, key, &raw, raw);
    if (err == ESP_OK) {
        *out_value = raw != 0;
    }
    return err;
}

esp_err_t prefs_put_float(const char *nvs_namespace, const char *key, float value)
{
    return prefs_put_blob(nvs_namespace, key, &value, sizeof(value));
}

esp_err_t prefs_get_float(const char *nvs_namespace, const char *key, float *out_value, float default_value)
{
    if (!key || !out_value) {
        return ESP_ERR_INVALID_ARG;
    }

    float value = default_value;
    size_t value_len = sizeof(value);
    esp_err_t err = prefs_get_blob(nvs_namespace, key, &value, &value_len);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        *out_value = default_value;
        return ESP_OK;
    }
    if (err != ESP_OK) {
        return err;
    }
    if (value_len != sizeof(float)) {
        return ESP_ERR_INVALID_SIZE;
    }

    *out_value = value;
    return ESP_OK;
}

esp_err_t prefs_put_str(const char *nvs_namespace, const char *key, const char *value)
{
    if (!key || !value) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(resolve_namespace(nvs_namespace), NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_set_str(handle, key, value);
    return commit_and_close(handle, err);
}

esp_err_t prefs_get_str(
    const char *nvs_namespace,
    const char *key,
    char *out_value,
    size_t out_value_len,
    const char *default_value)
{
    if (!key || !out_value || out_value_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(resolve_namespace(nvs_namespace), NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return err;
    }

    size_t value_len = out_value_len;
    err = nvs_get_str(handle, key, out_value, &value_len);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        copy_default_str(out_value, out_value_len, default_value);
        err = ESP_OK;
    }
    nvs_close(handle);
    return err;
}

esp_err_t prefs_put_blob(const char *nvs_namespace, const char *key, const void *value, size_t value_len)
{
    if (!key || !value || value_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(resolve_namespace(nvs_namespace), NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_set_blob(handle, key, value, value_len);
    return commit_and_close(handle, err);
}

esp_err_t prefs_get_blob(const char *nvs_namespace, const char *key, void *out_value, size_t *in_out_value_len)
{
    if (!key || !out_value || !in_out_value_len || *in_out_value_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(resolve_namespace(nvs_namespace), NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return err;
    }

    err = nvs_get_blob(handle, key, out_value, in_out_value_len);
    nvs_close(handle);
    return err;
}

esp_err_t put_char(const char *key, unsigned char value)
{
    return prefs_put_u8(NULL, key, (uint8_t)value);
}

char get_char(const char *key, unsigned char default_value)
{
    uint8_t value = (uint8_t)default_value;
    if (prefs_get_u8(NULL, key, &value, (uint8_t)default_value) != ESP_OK) {
        return (char)default_value;
    }
    return (char)value;
}
