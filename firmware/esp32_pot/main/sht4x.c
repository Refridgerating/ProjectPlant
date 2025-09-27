#include "sht4x.h"

#include "esp_log.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define SHT4X_I2C_ADDRESS 0x44
#define SHT4X_MEASURE_CMD 0xFD
#define SHT4X_SOFT_RESET_CMD 0x94

static const char *TAG = "sht4x";
static bool driver_installed = false;
static i2c_port_t active_port = I2C_NUM_0;

static uint8_t crc8(const uint8_t *data)
{
    uint8_t crc = 0xFF;
    for (int i = 0; i < 2; ++i) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; ++bit) {
            if (crc & 0x80) {
                crc = (crc << 1) ^ 0x31;
            } else {
                crc <<= 1;
            }
        }
    }
    return crc;
}

static esp_err_t sht4x_soft_reset(void)
{
    uint8_t cmd = SHT4X_SOFT_RESET_CMD;
    return i2c_master_write_to_device(active_port, SHT4X_I2C_ADDRESS, &cmd, sizeof(cmd), pdMS_TO_TICKS(50));
}

esp_err_t sht4x_init(i2c_port_t port, gpio_num_t sda_gpio, gpio_num_t scl_gpio)
{
    active_port = port;

    i2c_config_t conf = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = sda_gpio,
        .scl_io_num = scl_gpio,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 100000,
        .clk_flags = 0,
    };

    esp_err_t err = i2c_param_config(port, &conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c_param_config failed: %s", esp_err_to_name(err));
        return err;
    }

    if (!driver_installed) {
        err = i2c_driver_install(port, conf.mode, 0, 0, 0);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            ESP_LOGE(TAG, "i2c_driver_install failed: %s", esp_err_to_name(err));
            return err;
        }
        driver_installed = true;
    }

    err = sht4x_soft_reset();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SHT4x soft reset failed: %s", esp_err_to_name(err));
    }

    vTaskDelay(pdMS_TO_TICKS(10));
    return ESP_OK;
}

esp_err_t sht4x_read(float *temperature_c, float *humidity_pct)
{
    uint8_t cmd = SHT4X_MEASURE_CMD;
    esp_err_t err = i2c_master_write_to_device(active_port, SHT4X_I2C_ADDRESS, &cmd, sizeof(cmd), pdMS_TO_TICKS(50));
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to start measurement: %s", esp_err_to_name(err));
        return err;
    }

    vTaskDelay(pdMS_TO_TICKS(12));

    uint8_t raw[6] = {0};
    err = i2c_master_read_from_device(active_port, SHT4X_I2C_ADDRESS, raw, sizeof(raw), pdMS_TO_TICKS(50));
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to read data: %s", esp_err_to_name(err));
        return err;
    }

    if (crc8(&raw[0]) != raw[2] || crc8(&raw[3]) != raw[5]) {
        ESP_LOGW(TAG, "CRC mismatch on SHT4x data");
        return ESP_ERR_INVALID_CRC;
    }

    uint16_t raw_temp = ((uint16_t)raw[0] << 8) | raw[1];
    uint16_t raw_rh = ((uint16_t)raw[3] << 8) | raw[4];

    float temp = -45.0f + 175.0f * ((float)raw_temp / 65535.0f);
    float rh = -6.0f + 125.0f * ((float)raw_rh / 65535.0f);
    if (rh > 100.0f) {
        rh = 100.0f;
    } else if (rh < 0.0f) {
        rh = 0.0f;
    }

    if (temperature_c) {
        *temperature_c = temp;
    }
    if (humidity_pct) {
        *humidity_pct = rh;
    }
    return ESP_OK;
}
