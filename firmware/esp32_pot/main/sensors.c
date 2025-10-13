#include "sensors.h"

#include <math.h>

#include "driver/gpio.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "hardware_config.h"
#include "aht10.h"
#include "ads1115.h"

static const char *TAG = "sensors";
static bool pump_state = false;

static float soil_to_percent(uint16_t raw)
{
    // Generic mapping: higher raw => wetter; normalize to 0..100%.
    // ADS1115 single-ended full-scale = 32767 counts.
    const float max_raw = 32767.0f;
    float pct = 100.0f * (1.0f - ((float)raw / max_raw));
    if (pct < 0.0f) {
        pct = 0.0f;
    } else if (pct > 100.0f) {
        pct = 100.0f;
    }
    return pct;
}

void sensors_set_pump_state(bool on)
{
    // If turning ON, ensure cutoff float is not low; floats need sensor power
    if (on) {
        int prev = gpio_get_level(SENSOR_EN_GPIO);
        if (prev == 0) {
            gpio_set_level(SENSOR_EN_GPIO, 1);
            vTaskDelay(pdMS_TO_TICKS(SENSOR_POWER_ON_DELAY_MS));
        }
        bool cutoff_low = (gpio_get_level(WATER_CUTOFF_GPIO) == 0);
        if (prev == 0) {
            gpio_set_level(SENSOR_EN_GPIO, 0);
        }
        if (cutoff_low) {
            ESP_LOGW(TAG, "Pump ON blocked: cutoff float is LOW");
            on = false;
        }
    }
    gpio_set_level(PUMP_GPIO, on ? 1 : 0);
    pump_state = on;
}

bool sensors_get_pump_state(void)
{
    return pump_state;
}

void sensors_init(void)
{
    gpio_config_t pump_cfg = {
        .pin_bit_mask = BIT64(PUMP_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&pump_cfg);
    sensors_set_pump_state(false);

    // Sensor power enable (default OFF)
    gpio_config_t sen_cfg = {
        .pin_bit_mask = BIT64(SENSOR_EN_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&sen_cfg);
    gpio_set_level(SENSOR_EN_GPIO, 0);

    gpio_config_t float_cfg = {
        .pin_bit_mask = BIT64(WATER_REFILL_GPIO) | BIT64(WATER_CUTOFF_GPIO),
        .mode = GPIO_MODE_INPUT,
        // GPIO34/35 have no internal pull-ups; rely on external 100k to 3V3_SW
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&float_cfg);

    // Power sensors to initialize I2C devices
    gpio_set_level(SENSOR_EN_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(SENSOR_POWER_ON_DELAY_MS));

    esp_err_t err = aht10_init(I2C_PORT_NUM, I2C_SDA_GPIO, I2C_SCL_GPIO);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "AHT10 init failed: %s", esp_err_to_name(err));
    }
    err = ads1115_init(I2C_PORT_NUM, I2C_SDA_GPIO, I2C_SCL_GPIO);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ADS1115 init failed: %s", esp_err_to_name(err));
    }

    // Optionally power sensors back off after init
    gpio_set_level(SENSOR_EN_GPIO, 0);
}

void sensors_collect(sensor_reading_t *out)
{
    if (!out) {
        return;
    }

    // Power sensors
    gpio_set_level(SENSOR_EN_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(SENSOR_POWER_ON_DELAY_MS));

    // Soil moisture via ADS1115 (AIN0)
    int32_t acc = 0;
    for (int i = 0; i < SOIL_SAMPLES; ++i) {
        int16_t sample = 0;
        esp_err_t err = ads1115_read_single_ended(SOIL_ADC_CHANNEL, ADS1115_PGA_4096, &sample);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "ADS1115 read failed: %s", esp_err_to_name(err));
            sample = 0;
        }
        if (sample < 0) sample = 0; // single-ended should be >= 0
        acc += sample;
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    out->soil_raw = (uint16_t)(acc / SOIL_SAMPLES);
    out->soil_percent = soil_to_percent(out->soil_raw);

    // Float switches (active-low); valid only when sensors are powered
    out->water_low = gpio_get_level(WATER_REFILL_GPIO) == 0;      // refill indicator
    out->water_cutoff = gpio_get_level(WATER_CUTOFF_GPIO) == 0;   // cutoff indicator

    // Temperature/Humidity from AHT10
    float t = NAN, rh = NAN;
    if (aht10_read(&t, &rh) == ESP_OK) {
        out->temperature_c = t;
        out->humidity_pct = rh;
    } else {
        out->temperature_c = NAN;
        out->humidity_pct = NAN;
    }

    // Safety: if pump is on and cutoff is low, turn pump off immediately
    if (sensors_get_pump_state() && out->water_cutoff) {
        ESP_LOGW(TAG, "Cutoff float low -> turning pump OFF");
        sensors_set_pump_state(false);
    }
    out->pump_is_on = sensors_get_pump_state();
    out->timestamp_ms = esp_timer_get_time() / 1000ULL;

    // Power sensors off
    gpio_set_level(SENSOR_EN_GPIO, 0);
}
