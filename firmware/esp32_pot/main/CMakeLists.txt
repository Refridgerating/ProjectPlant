set(SRCS
    "app_main.c"
    "device_identity.c"
    "sensors.c"
    "plant_mqtt.c"
    "wifi.c"
    "time_sync.c"
    "aht10.c"
    "ads1115.c"
    "preferences.c"
    "node_schedule.c"
    "startup_onboarding.c"
)

if(EXISTS "${CMAKE_CURRENT_LIST_DIR}/hardware_config.local.c")
    list(APPEND SRCS "hardware_config.local.c")
else()
    list(APPEND SRCS "hardware_config.c")
endif()

idf_component_register(
    SRCS ${SRCS}
    INCLUDE_DIRS "."
    REQUIRES driver esp_wifi esp_event esp_netif nvs_flash mqtt json wifi_provisioning protocomm
)
