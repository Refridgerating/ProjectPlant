#include "ads1115.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define ADS1115_ADDR            0x48
#define ADS1115_REG_CONVERSION  0x00
#define ADS1115_REG_CONFIG      0x01

static const char *TAG = "ads1115";
static bool driver_installed = false;
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

    esp_err_t err = ads1115_write_reg(ADS1115_REG_CONFIG, cfg);
    if (err != ESP_OK) return err;

    // Wait for conversion (128 SPS ~7.8ms); give margin
    vTaskDelay(pdMS_TO_TICKS(10));

    uint8_t raw[2];
    err = ads1115_read_reg(ADS1115_REG_CONVERSION, raw, sizeof raw);
    if (err != ESP_OK) return err;

    *out_counts = (int16_t)((raw[0] << 8) | raw[1]);
    return ESP_OK;
}

