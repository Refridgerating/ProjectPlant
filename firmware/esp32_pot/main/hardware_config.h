#pragma once

// Device identity defaults (derived from MAC; display name stored in NVS)
#define DEVICE_ID_PREFIX        "pot"
#define DEVICE_NAME_PREFIX      "Pot"

// Fallback Wi-Fi credentials (used if no provisioned credentials are available)
// Values are defined in hardware_config.c or hardware_config.local.c (git-ignored).
extern const char *WIFI_SSID;
extern const char *WIFI_PASS;

// MQTT broker configuration
extern const char *MQTT_BROKER_URI;
extern const char *MQTT_USERNAME;
extern const char *MQTT_PASSWORD;
#define MQTT_PING_TOPIC         "lab/ping"
#define MQTT_PING_INTERVAL_MS   30000      // send heartbeat ping every 30 s

// External ADC (ADS1115) + sensor power gating
// Wiring: ADS1115 @ 0x48 on I2C; AIN0 = soil sensor; AIN1 = battery divider (1M : 330k)
#define ADS1115_I2C_ADDRESS     0x48
#define SOIL_ADC_CHANNEL        1           // ADS1115 AIN0
#define BATTERY_ADC_CHANNEL     0           // ADS1115 AIN1
#define SOIL_SAMPLES            16

// Soil moisture calibration (ADS1115 counts)
#define SOIL_SENSOR_RAW_DRY     17040       // Completely dry soil
#define SOIL_SENSOR_RAW_WET     7507        // Waterlogged soil

// Pump control GPIO (drives IRLZ44N gate via 100 ohm gate resistor)
#define PUMP_GPIO               GPIO_NUM_23 // Pump MOSFET gate input

// Fan control GPIO (circulation fan MOSFET/relay)
#define FAN_GPIO                GPIO_NUM_25

// Ultrasonic mister control GPIO (logic-level MOSFET)
#define MISTER_GPIO             GPIO_NUM_33

// Grow light control GPIO (relay/MOSFET)
#define LIGHT_GPIO              GPIO_NUM_19

// Sensor power switch (P-MOSFET FQP27P06 via 2N3904)
// Logic: drive HIGH to enable sensors (pull P-MOSFET gate low via NPN)
#define SENSOR_EN_GPIO          GPIO_NUM_27
#define SENSOR_POWER_ON_DELAY_MS 150        // allow sensors/I2C to power-stabilize and I2C settle

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
