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
    setenv("TZ", "UTC0", 1);
    tzset();
    sntp_started = true;
    ESP_LOGI(TAG, "Time zone set to UTC");
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
