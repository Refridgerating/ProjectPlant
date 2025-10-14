#include "unity.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "plant_mqtt.h"

static mqtt_command_t parse_command(const char *json)
{
    return mqtt_parse_command(json, (int)strlen(json));
}

void setUp(void) {}
void tearDown(void) {}

void test_parse_sensor_read_action_field(void)
{
    const char *json = "{\"action\":\"sensor_read\",\"requestId\":\"req-123\"}";
    mqtt_command_t cmd = parse_command(json);

    TEST_ASSERT_EQUAL(MQTT_CMD_SENSOR_READ, cmd.type);
    TEST_ASSERT_EQUAL_STRING("req-123", cmd.request_id);
    TEST_ASSERT_FALSE(cmd.pump_on);
    TEST_ASSERT_EQUAL_UINT32(0, cmd.duration_ms);
}

void test_parse_sensor_read_command_field(void)
{
    const char *json = "{\"command\":\"sensorRead\",\"requestId\":\"abc-789\"}";
    mqtt_command_t cmd = parse_command(json);

    TEST_ASSERT_EQUAL(MQTT_CMD_SENSOR_READ, cmd.type);
    TEST_ASSERT_EQUAL_STRING("abc-789", cmd.request_id);
    TEST_ASSERT_FALSE(cmd.pump_on);
}

void test_parse_pump_override_command(void)
{
    const char *json = "{\"pump\":\"on\",\"duration_ms\":1500}";
    mqtt_command_t cmd = parse_command(json);

    TEST_ASSERT_EQUAL(MQTT_CMD_PUMP_OVERRIDE, cmd.type);
    TEST_ASSERT_TRUE(cmd.pump_on);
    TEST_ASSERT_EQUAL_UINT32(1500, cmd.duration_ms);
    TEST_ASSERT_EQUAL_CHAR('\0', cmd.request_id[0]);
}

void test_parse_ignores_invalid_json(void)
{
    const char *json = "{invalid json";
    mqtt_command_t cmd = mqtt_parse_command(json, (int)strlen(json));

    TEST_ASSERT_EQUAL(MQTT_CMD_UNKNOWN, cmd.type);
    TEST_ASSERT_EQUAL_CHAR('\0', cmd.request_id[0]);
    TEST_ASSERT_FALSE(cmd.pump_on);
    TEST_ASSERT_EQUAL_UINT32(0, cmd.duration_ms);
}

void test_parse_truncates_long_request_id(void)
{
    char long_id[80];
    memset(long_id, 'a', sizeof(long_id));
    long_id[sizeof(long_id) - 1] = '\0';

    char json[160];
    snprintf(json, sizeof(json), "{\"action\":\"sensor_read\",\"requestId\":\"%s\"}", long_id);

    mqtt_command_t cmd = parse_command(json);

    TEST_ASSERT_EQUAL(MQTT_CMD_SENSOR_READ, cmd.type);
    TEST_ASSERT_EQUAL_CHAR('\0', cmd.request_id[0]);
}

void app_main(void)
{
    UNITY_BEGIN();
    RUN_TEST(test_parse_sensor_read_action_field);
    RUN_TEST(test_parse_sensor_read_command_field);
    RUN_TEST(test_parse_pump_override_command);
    RUN_TEST(test_parse_ignores_invalid_json);
    RUN_TEST(test_parse_truncates_long_request_id);
    UNITY_END();
}
