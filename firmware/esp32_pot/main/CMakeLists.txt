idf_component_register(
    SRCS
        "app_main.c"
        "sensors.c"
        "plant_mqtt.c"
        "wifi.c"
        "sht4x.c"
    INCLUDE_DIRS "."
    REQUIRES driver esp_wifi esp_event esp_netif nvs_flash mqtt json esp_adc
)
