#include "sensors.h"

#include <math.h>
#include <string.h>
#include <sys/time.h>

#include "driver/gpio.h"
#include "driver/i2c.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "hardware_config.h"
#include "device_identity.h"
#include "aht10.h"
#include "ads1115.h"
#include "time_sync.h"

#include "preferences.h"  // DEBUG

static const char *TAG = "sensors";
static bool pump_state = false;
static bool fan_state = false;
static bool mister_state = false;
static bool light_state = false;
static bool i2c_ready = false;

static esp_err_t ensure_i2c_bus(void)
{
    if (i2c_ready) {
        return ESP_OK;
    }

    i2c_config_t conf = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = I2C_SDA_GPIO,
        .scl_io_num = I2C_SCL_GPIO,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 100000,
        .clk_flags = 0,
    };

    esp_err_t err = i2c_param_config(I2C_PORT_NUM, &conf);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "I2C param config failed: %s", esp_err_to_name(err));
        return err;
    }

    err = i2c_driver_install(I2C_PORT_NUM, conf.mode, 0, 0, 0);
    if (err != ESP_OK) {
        if (err == ESP_ERR_INVALID_STATE || err == ESP_FAIL) {
            ESP_LOGW(TAG, "I2C driver already installed on port %d", I2C_PORT_NUM);
        } else {
            ESP_LOGE(TAG, "I2C driver install failed: %s", esp_err_to_name(err));
            return err;
        }
    } else {
        ESP_LOGI(TAG, "I2C driver installed on port %d", I2C_PORT_NUM);
    }

    i2c_ready = true;
    return ESP_OK;
}

static float soil_to_percent(uint16_t raw)
{
    // Calibrated linear mapping: higher counts = drier soil.
    const float dry = (float)SOIL_SENSOR_RAW_DRY;
    const float wet = (float)SOIL_SENSOR_RAW_WET;
    const float span = dry - wet;

    if (span <= 0.0f) {
        return 0.0f;
    }

    float pct = ((dry - (float)raw) / span) * 100.0f;
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
    if (on && device_identity_sensors_enabled()) {
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

void sensors_set_fan_state(bool on)
{
    gpio_set_level(FAN_GPIO, on ? 1 : 0);
    fan_state = on;
}

bool sensors_get_fan_state(void)
{
    return fan_state;
}

void sensors_set_mister_state(bool on)
{
    gpio_set_level(MISTER_GPIO, on ? 1 : 0);
    mister_state = on;
}

bool sensors_get_mister_state(void)
{
    return mister_state;
}

void sensors_set_light_state(bool on)
{
    gpio_set_level(LIGHT_GPIO, on ? 1 : 0);
    light_state = on;
}

bool sensors_get_light_state(void)
{
    return light_state;
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

    gpio_config_t fan_cfg = {
        .pin_bit_mask = BIT64(FAN_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&fan_cfg);
    sensors_set_fan_state(false);

    gpio_config_t mister_cfg = {
        .pin_bit_mask = BIT64(MISTER_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&mister_cfg);
    sensors_set_mister_state(false);

    gpio_config_t light_cfg = {
        .pin_bit_mask = BIT64(LIGHT_GPIO),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&light_cfg);
    sensors_set_light_state(false);

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

    if (ensure_i2c_bus() != ESP_OK) {
        ESP_LOGE(TAG, "I2C bus init failed; sensors unavailable");
        return;
    }

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

    if (!device_identity_sensors_enabled()) {
        out->soil_raw = 0;
        out->soil_percent = 0.0f;
        out->temperature_c = NAN;
        out->humidity_pct = NAN;
        out->water_low = false;
        out->water_cutoff = false;
        out->pump_is_on = sensors_get_pump_state();
        out->fan_is_on = sensors_get_fan_state();
        out->mister_is_on = sensors_get_mister_state();
        out->light_is_on = sensors_get_light_state();

        uint64_t timestamp_ms = esp_timer_get_time() / 1000ULL;
        if (time_sync_is_time_valid()) {
            struct timeval now;
            if (gettimeofday(&now, NULL) == 0) {
                timestamp_ms = ((uint64_t)now.tv_sec * 1000ULL) + ((uint64_t)now.tv_usec / 1000ULL);
            }
        }
        out->timestamp_ms = timestamp_ms;
        gpio_set_level(SENSOR_EN_GPIO, 0);
        return;
    }

    if (!i2c_ready && ensure_i2c_bus() != ESP_OK) {
        ESP_LOGE(TAG, "I2C bus unavailable during collection");
        memset(out, 0, sizeof(*out));
        out->temperature_c = NAN;
        out->humidity_pct = NAN;
        out->pump_is_on = sensors_get_pump_state();
        out->fan_is_on = sensors_get_fan_state();
        out->mister_is_on = sensors_get_mister_state();
        out->light_is_on = sensors_get_light_state();
        return;
    }

    // Power sensors
    gpio_set_level(SENSOR_EN_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(SENSOR_POWER_ON_DELAY_MS + 50)); // extra margin for ADC settling

    // Soil moisture via ADS1115 (AIN0)
    int32_t acc = 0;
    int valid_samples = 0;
    for (int i = 0; i < SOIL_SAMPLES; ++i) {
        int16_t sample = 0;
        esp_err_t err = ads1115_read_single_ended(SOIL_ADC_CHANNEL, ADS1115_PGA_4096, &sample);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "ADS1115 read failed (sample %d/%d): %s", i + 1, SOIL_SAMPLES, esp_err_to_name(err));
            vTaskDelay(pdMS_TO_TICKS(20)); // back off before retry
            continue;
        }
        if (sample < 0) sample = 0; // single-ended should be >= 0
        acc += sample;
        valid_samples++;
        vTaskDelay(pdMS_TO_TICKS(5));
    }
    
    if (valid_samples == 0) {
        ESP_LOGE(TAG, "ADS1115: no valid samples collected");
        out->soil_raw = 0;
        out->soil_percent = 0.0f;
    } else {
        out->soil_raw = (uint16_t)(acc / valid_samples);
        out->soil_percent = soil_to_percent(out->soil_raw);
        ESP_LOGD(TAG, "Soil: %d valid samples, raw=%u, percent=%.1f%%", valid_samples, out->soil_raw, out->soil_percent);
        
        // DEBUG
        ESP_LOGI(TAG, "Soil moisture: %.1f%% (raw %u)", out->soil_percent, out->soil_raw);
        if (out->soil_percent >= 50.0f) {
            ESP_LOGI(TAG, "Soil moisture is above 50%% threshold");
            esp_err_t err = put_char("test_var", '0');  // DEBUG: Chris
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "Failed to set test_var: %s", esp_err_to_name(err));
            }
        }
    }

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
    out->fan_is_on = sensors_get_fan_state();
    out->mister_is_on = sensors_get_mister_state();
    out->light_is_on = sensors_get_light_state();

    uint64_t timestamp_ms = esp_timer_get_time() / 1000ULL;
    if (time_sync_is_time_valid()) {
        struct timeval now;
        if (gettimeofday(&now, NULL) == 0) {
            timestamp_ms = ((uint64_t)now.tv_sec * 1000ULL) + ((uint64_t)now.tv_usec / 1000ULL);
        }
    }
    out->timestamp_ms = timestamp_ms;

    // Power sensors off
    gpio_set_level(SENSOR_EN_GPIO, 0);
}
