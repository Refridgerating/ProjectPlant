#pragma once

#include "driver/i2c.h"
#include "esp_err.h"
#include <stdint.h>

// Minimal ADS1115 driver for single-ended reads on AIN0..AIN3

typedef enum {
    ADS1115_PGA_6144 = 0,  // ±6.144 V
    ADS1115_PGA_4096 = 1,  // ±4.096 V
    ADS1115_PGA_2048 = 2,  // ±2.048 V (default)
    ADS1115_PGA_1024 = 3,  // ±1.024 V
    ADS1115_PGA_0512 = 4,  // ±0.512 V
    ADS1115_PGA_0256 = 5,  // ±0.256 V
} ads1115_pga_t;

esp_err_t ads1115_init(i2c_port_t port, gpio_num_t sda_gpio, gpio_num_t scl_gpio);
esp_err_t ads1115_read_single_ended(uint8_t channel, ads1115_pga_t pga, int16_t *out_counts);

// Utility to convert raw counts to volts for the provided PGA
static inline float ads1115_counts_to_volts(int16_t counts, ads1115_pga_t pga)
{
    float fs = 2.048f; // default for ADS1115_PGA_2048
    switch (pga) {
        case ADS1115_PGA_6144: fs = 6.144f; break;
        case ADS1115_PGA_4096: fs = 4.096f; break;
        case ADS1115_PGA_2048: fs = 2.048f; break;
        case ADS1115_PGA_1024: fs = 1.024f; break;
        case ADS1115_PGA_0512: fs = 0.512f; break;
        case ADS1115_PGA_0256: fs = 0.256f; break;
        default: fs = 2.048f; break;
    }
    return ((float)counts / 32768.0f) * fs;
}

