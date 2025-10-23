#include "ads1115.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define ADS1115_ADDR            0x48
#define ADS1115_REG_CONVERSION  0x00
#define ADS1115_REG_CONFIG      0x01

static const char *TAG = "ads1115";
static i2c_port_t active_port = I2C_NUM_0;

static esp_err_t ads1115_write_reg(uint8_t reg, uint16_t value)
{
    uint8_t payload[3];
    payload[0] = reg;
    payload[1] = (uint8_t)(value >> 8);
    payload[2] = (uint8_t)(value & 0xFF);
    return i2c_master_write_to_device(active_port, ADS1115_ADDR, payload, sizeof(payload), pdMS_TO_TICKS(50));
}

static esp_err_t ads1115_read_reg(uint8_t reg, uint8_t *buf, size_t len)
{
    esp_err_t err = i2c_master_write_to_device(active_port, ADS1115_ADDR, &reg, 1, pdMS_TO_TICKS(50));
    if (err != ESP_OK) return err;
    return i2c_master_read_from_device(active_port, ADS1115_ADDR, buf, len, pdMS_TO_TICKS(50));
}

esp_err_t ads1115_init(i2c_port_t port, gpio_num_t sda_gpio, gpio_num_t scl_gpio)
{
    (void)sda_gpio;
    (void)scl_gpio;
    active_port = port;
    return ESP_OK;
}

esp_err_t ads1115_read_single_ended(uint8_t channel, ads1115_pga_t pga, int16_t *out_counts)
{
    if (channel > 3 || out_counts == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    // Config register layout:
    // [15] OS=1 (start single conversion)
    // [14:12] MUX = 100 + channel (AINx vs GND)
    // [11:9] PGA
    // [8] MODE=1 (single-shot)
    // [7:5] DR (128 SPS = 100)
    // [4:0] comparator disabled (default 00011)

    uint16_t mux = 0x04 + channel; // 100b + ch
    uint16_t cfg = 0;
    cfg |= (1u << 15);                 // OS = 1 (start)
    cfg |= (mux & 0x07) << 12;         // MUX
    cfg |= ((uint16_t)pga & 0x07) << 9;// PGA
    cfg |= (1u << 8);                  // MODE = single-shot
    cfg |= (0x04u << 5);               // DR = 128 SPS
    cfg |= 0x0003;                     // disable comparator

    // Retry logic with exponential backoff for transient I2C errors
    const int max_retries = 3;
    esp_err_t err = ESP_OK;
    
    for (int attempt = 0; attempt < max_retries; attempt++) {
        err = ads1115_write_reg(ADS1115_REG_CONFIG, cfg);
        if (err == ESP_OK) break;
        ESP_LOGW(TAG, "Config write failed (attempt %d/%d): %s", attempt + 1, max_retries, esp_err_to_name(err));
        vTaskDelay(pdMS_TO_TICKS(10 * (1 << attempt))); // exponential backoff: 10, 20, 40ms
    }
    
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ADS1115 channel %d config write exhausted retries", channel);
        return err;
    }

    // Wait for conversion (128 SPS ~7.8ms); add margin for clock variance
    vTaskDelay(pdMS_TO_TICKS(15));

    uint8_t raw[2];
    for (int attempt = 0; attempt < max_retries; attempt++) {
        err = ads1115_read_reg(ADS1115_REG_CONVERSION, raw, sizeof raw);
        if (err == ESP_OK) break;
        ESP_LOGW(TAG, "Conversion read failed (attempt %d/%d): %s", attempt + 1, max_retries, esp_err_to_name(err));
        vTaskDelay(pdMS_TO_TICKS(10 * (1 << attempt))); // exponential backoff
    }
    
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ADS1115 channel %d conversion read exhausted retries", channel);
        return err;
    }

    *out_counts = (int16_t)((raw[0] << 8) | raw[1]);
    ESP_LOGD(TAG, "Channel %d: raw=%d (0x%04x)", channel, *out_counts, (uint16_t)*out_counts);
    return ESP_OK;
}

