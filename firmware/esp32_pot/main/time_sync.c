#include "time_sync.h"

#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "time_sync";
static const time_t MIN_VALID_EPOCH = 1609459200; // 2021-01-01T00:00:00Z
static const char *UTC_TZ = "UTC0";

static bool sntp_started = false;

static bool is_epoch_valid(time_t now)
{
    return now >= MIN_VALID_EPOCH;
}

esp_err_t time_sync_init(void)
{
    if (sntp_started) {
        return ESP_OK;
    }

    const esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    esp_err_t err = esp_netif_sntp_init(&config);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "Failed to init SNTP: %s", esp_err_to_name(err));
        return err;
    }
    if (err == ESP_OK) {
        esp_netif_sntp_start();
        ESP_LOGI(TAG, "SNTP service started");
    } else {
        ESP_LOGI(TAG, "SNTP already initialized");
    }
    time_sync_set_timezone(NULL);
    sntp_started = true;
    return ESP_OK;
}

bool time_sync_is_time_valid(void)
{
    time_t now = 0;
    time(&now);
    if (is_epoch_valid(now)) {
        return true;
    }

    struct timeval tv = {0};
    if (gettimeofday(&tv, NULL) == 0) {
        return is_epoch_valid(tv.tv_sec);
    }
    return false;
}

bool time_sync_wait_for_valid(TickType_t timeout_ticks)
{
    const TickType_t delay = pdMS_TO_TICKS(500);
    TickType_t waited = 0;

    while (!time_sync_is_time_valid()) {
        if (timeout_ticks != portMAX_DELAY && waited >= timeout_ticks) {
            return time_sync_is_time_valid();
        }
        vTaskDelay(delay);
        if (timeout_ticks != portMAX_DELAY) {
            waited += delay;
        }
    }
    return true;
}

esp_err_t time_sync_set_timezone(const char *timezone_posix)
{
    const char *effective_tz = UTC_TZ;
    if (timezone_posix && timezone_posix[0] != '\0') {
        effective_tz = timezone_posix;
    }

    if (setenv("TZ", effective_tz, 1) != 0) {
        ESP_LOGE(TAG, "Failed to set TZ to %s", effective_tz);
        return ESP_FAIL;
    }

    tzset();
    ESP_LOGI(TAG, "Time zone set to %s", effective_tz);
    return ESP_OK;
}

bool time_sync_get_timezone_offset_minutes(int16_t *out_offset_minutes)
{
    if (!out_offset_minutes) {
        return false;
    }

    if (!time_sync_is_time_valid()) {
        return false;
    }

    time_t now = 0;
    time(&now);

    struct tm tm_utc;
    if (gmtime_r(&now, &tm_utc) == NULL) {
        return false;
    }
    tm_utc.tm_isdst = -1;

    time_t utc_as_local = mktime(&tm_utc);
    if (utc_as_local == (time_t)-1) {
        return false;
    }

    double offset_seconds = difftime(now, utc_as_local);
    *out_offset_minutes = (int16_t)(offset_seconds / 60.0);
    return true;
}
