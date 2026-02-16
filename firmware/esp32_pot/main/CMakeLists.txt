idf_component_register(
    SRCS
        "app_main.c"
        "device_identity.c"
        "sensors.c"
        "plant_mqtt.c"
        "wifi.c"
        "time_sync.c"
        "aht10.c"
        "ads1115.c"
    INCLUDE_DIRS "."
    REQUIRES driver esp_wifi esp_event esp_netif nvs_flash mqtt json
)
