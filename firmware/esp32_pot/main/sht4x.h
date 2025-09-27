#pragma once

#include "driver/gpio.h"
#include "driver/i2c.h"
#include "esp_err.h"

esp_err_t sht4x_init(i2c_port_t port, gpio_num_t sda_gpio, gpio_num_t scl_gpio);
esp_err_t sht4x_read(float *temperature_c, float *humidity_pct);
