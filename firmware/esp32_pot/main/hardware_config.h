#pragma once

// Device identity (override via menuconfig or NVS in future revisions)
#define DEVICE_ID               "pot-01"

// Wi-Fi credentials (placeholder - replace before flashing)
#define WIFI_SSID               "ARRIS-D982"
#define WIFI_PASS               "2SY9AD602202"

// MQTT broker configuration
#define MQTT_BROKER_URI         "mqtt://192.168.0.15:1883"
#define MQTT_USERNAME           NULL
#define MQTT_PASSWORD           NULL

// External ADC (ADS1115) + sensor power gating
// Wiring: ADS1115 @ 0x48 on I2C; AIN0 = soil sensor; AIN1 = battery divider (1M : 330k)
#define ADS1115_I2C_ADDRESS     0x48
#define SOIL_ADC_CHANNEL        1           // ADS1115 AIN0
#define BATTERY_ADC_CHANNEL     0           // ADS1115 AIN1
#define SOIL_SAMPLES            16

// Pump control GPIO (drives IRLZ44N gate via 100Ω)
#define PUMP_GPIO               GPIO_NUM_23 // Matches wiring: GPIO23 → MOSFET gate

// Sensor power switch (P-MOSFET FQP27P06 via 2N3904)
// Logic: drive HIGH to enable sensors (pull P-MOSFET gate low via NPN)
#define SENSOR_EN_GPIO          GPIO_NUM_27
#define SENSOR_POWER_ON_DELAY_MS 100        // allow sensors/I2C to power-stabilize

// Water level float switches (active-low), external 100k pull-ups to 3V3_SW
// On ESP32: GPIO34/35 are input-only and have no internal pull-ups; rely on external pull-ups.
#define WATER_REFILL_GPIO       GPIO_NUM_34   // Reservoir refill indicator (low = needs refill)
#define WATER_CUTOFF_GPIO       GPIO_NUM_35   // Immediate pump cutoff level (low = stop pump)

// I2C pins (shared by AHT10 + ADS1115)
#define I2C_SDA_GPIO            GPIO_NUM_21
#define I2C_SCL_GPIO            GPIO_NUM_22
#define I2C_PORT_NUM            I2C_NUM_0

// Task configuration
#define MEASUREMENT_INTERVAL_MS 60000
#define SENSOR_TASK_STACK       4096
#define MQTT_TASK_STACK         4096
#define WIFI_TASK_PRIORITY      5
#define SENSOR_TASK_PRIORITY    5
#define MQTT_TASK_PRIORITY      5

// MQTT topics (canonical schema)
#define SENSORS_TOPIC_FMT       "pots/%s/sensors"
#define STATUS_TOPIC_FMT        "pots/%s/status"
#define COMMAND_TOPIC_FMT       "pots/%s/command"

