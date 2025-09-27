#include "sensors.h"

#include <math.h>

#include "driver/gpio.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "hardware_config.h"
#include "sht4x.h"

static const char *TAG = "sensors";
static bool pump_state = false;
static adc_oneshot_unit_handle_t soil_adc_handle = NULL;

static float soil_to_percent(uint16_t raw)
{
    const float min_raw = 900.0f;
    const float max_raw = 2600.0f;
    float pct = 100.0f * (raw - max_raw) / (min_raw - max_raw);
    if (pct < 0.0f) {
        pct = 0.0f;
    } else if (pct > 100.0f) {
        pct = 100.0f;
    }
    return pct;
}

void sensors_set_pump_state(bool on)
{
    gpio_set_level(PUMP_GPIO, on ? 1 : 0);
    pump_state = on;
}

bool sensors_get_pump_state(void)
{
    return pump_state;
}

void sensors_init(void)
{
    adc_oneshot_unit_init_cfg_t unit_cfg = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    esp_err_t err = adc_oneshot_new_unit(&unit_cfg, &soil_adc_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init ADC unit: %s", esp_err_to_name(err));
    } else {
        adc_oneshot_chan_cfg_t chan_cfg = {
            .bitwidth = ADC_BITWIDTH_12,
            .atten = ADC_ATTEN_DB_12,
        };
        err = adc_oneshot_config_channel(soil_adc_handle, SOIL_ADC_CHANNEL, &chan_cfg);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to config ADC channel: %s", esp_err_to_name(err));
        }
    }

    gpio_config_t pump_cfg = {
        .pin_bit_mask = BIT64(PUMP_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&pump_cfg);
    sensors_set_pump_state(false);

    gpio_config_t float_cfg = {
        .pin_bit_mask = BIT64(WATER_FLOAT_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&float_cfg);

    err = sht4x_init(I2C_PORT_NUM, I2C_SDA_GPIO, I2C_SCL_GPIO);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SHT4x init failed: %s", esp_err_to_name(err));
    }
}

void sensors_collect(sensor_reading_t *out)
{
    if (!out) {
        return;
    }

    uint32_t acc = 0;
    for (int i = 0; i < SOIL_SAMPLES; ++i) {
        int sample = 0;
        if (soil_adc_handle) {
            esp_err_t err = adc_oneshot_read(soil_adc_handle, SOIL_ADC_CHANNEL, &sample);
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "ADC read failed: %s", esp_err_to_name(err));
                sample = 0;
            }
        }
        acc += (uint32_t)sample;
        vTaskDelay(pdMS_TO_TICKS(10));
    }

    out->soil_raw = acc / SOIL_SAMPLES;
    out->soil_percent = soil_to_percent(out->soil_raw);
    out->pump_is_on = sensors_get_pump_state();
    out->water_low = gpio_get_level(WATER_FLOAT_GPIO) == 0;
    out->timestamp_ms = esp_timer_get_time() / 1000ULL;

    float t = NAN;
    float rh = NAN;
    if (sht4x_read(&t, &rh) == ESP_OK) {
        out->temperature_c = t;
        out->humidity_pct = rh;
    } else {
        out->temperature_c = NAN;
        out->humidity_pct = NAN;
    }
}
