#include "aht10.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "preferences.h"  // Chris

#define AHT10_ADDR         0x38
#define AHT10_CMD_RESET    0xBA
#define AHT10_CMD_CALIB    0xE1
#define AHT10_CMD_TRIGGER  0xAC

static const char *TAG = "aht10";
static i2c_port_t active_port = I2C_NUM_0;

static esp_err_t aht10_write_bytes(const uint8_t *data, size_t len)
{
    return i2c_master_write_to_device(active_port, AHT10_ADDR, data, len, pdMS_TO_TICKS(50));
}

static esp_err_t aht10_read_bytes(uint8_t *data, size_t len)
{
    return i2c_master_read_from_device(active_port, AHT10_ADDR, data, len, pdMS_TO_TICKS(50));
}

esp_err_t aht10_init(i2c_port_t port, gpio_num_t sda_gpio, gpio_num_t scl_gpio)
{
    (void)sda_gpio;
    (void)scl_gpio;
    active_port = port;

    // Soft reset then quick calibration
    uint8_t reset = AHT10_CMD_RESET;
    (void)aht10_write_bytes(&reset, 1);
    vTaskDelay(pdMS_TO_TICKS(20));

    uint8_t calib[3] = { AHT10_CMD_CALIB, 0x08, 0x00 };
    (void)aht10_write_bytes(calib, sizeof(calib));
    vTaskDelay(pdMS_TO_TICKS(10));
    return ESP_OK;
}

esp_err_t aht10_read(float *temperature_c, float *humidity_pct)
{
    // Trigger measurement: 0xAC 0x33 0x00
    uint8_t trig[3] = { AHT10_CMD_TRIGGER, 0x33, 0x00 };
    esp_err_t err = aht10_write_bytes(trig, sizeof(trig));
    if (err != ESP_OK) {
        return err;
    }
    vTaskDelay(pdMS_TO_TICKS(80));

    uint8_t buf[6] = {0};
    err = aht10_read_bytes(buf, sizeof(buf));
    if (err != ESP_OK) {
        return err;
    }
    // Check busy flag (bit7 of status byte)
    if ((buf[0] & 0x80) != 0) {
        // Still busy
        vTaskDelay(pdMS_TO_TICKS(20));
        err = aht10_read_bytes(buf, sizeof(buf));
        if (err != ESP_OK) return err;
    }

    uint32_t raw_h = ((uint32_t)buf[1] << 16) | ((uint32_t)buf[2] << 8) | ((uint32_t)buf[3]);
    raw_h >>= 4;
    uint32_t raw_t = (((uint32_t)buf[3] & 0x0F) << 16) | ((uint32_t)buf[4] << 8) | (uint32_t)buf[5];

    float rh = ((float)raw_h / 1048576.0f) * 100.0f;        // 20-bit full-scale
    float tc = ((float)raw_t / 1048576.0f) * 200.0f - 50.0f;

    if (humidity_pct) {
        if (rh < 0.0f) rh = 0.0f; else if (rh > 100.0f) rh = 100.0f;
        *humidity_pct = rh;
    }
    if (temperature_c) {
        *temperature_c = tc;
    }
    if (tc > 30.0f) {
        ESP_LOGI(TAG, "Temperature reading: %.2f C (raw %u)", tc, raw_t);
        esp_err_t err = put_char("test_var", '1');  // DEBUG: Chris
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Failed to set test_var: %s", esp_err_to_name(err));
        }
    }
    return ESP_OK;
}

