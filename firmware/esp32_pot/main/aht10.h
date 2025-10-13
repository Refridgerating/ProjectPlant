#pragma once

#include "driver/i2c.h"
#include "esp_err.h"

// Minimal AHT10 driver (temperature + humidity)
// Address: 0x38 (7-bit)

esp_err_t aht10_init(i2c_port_t port, gpio_num_t sda_gpio, gpio_num_t scl_gpio);
esp_err_t aht10_read(float *temperature_c, float *humidity_pct);

