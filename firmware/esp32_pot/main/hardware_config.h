#pragma once

// Device identity (override via menuconfig or NVS in future revisions)
#define DEVICE_ID               "pot-01"

// Wi-Fi credentials (placeholder - replace before flashing)
#define WIFI_SSID               "your-ssid"
#define WIFI_PASS               "your-password"

// MQTT broker configuration
#define MQTT_BROKER_URI         "mqtt://192.168.1.10"
#define MQTT_USERNAME           NULL
#define MQTT_PASSWORD           NULL

// Soil moisture ADC configuration
#define SOIL_ADC_CHANNEL        ADC_CHANNEL_6    // ADC1 channel 6 (GPIO34)
#define SOIL_SAMPLES            16

// Pump control GPIO (drives MOSFET gate)
#define PUMP_GPIO               GPIO_NUM_16

// Water level float switch input (active low)
#define WATER_FLOAT_GPIO        GPIO_NUM_4

// I2C pins for SHT41 (adjust for board wiring)
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

// MQTT topics
#define TELEMETRY_TOPIC_FMT     "projectplant/pots/%s/telemetry"
#define STATUS_TOPIC_FMT        "projectplant/pots/%s/status"
#define COMMAND_TOPIC_FMT       "projectplant/pots/%s/command"

