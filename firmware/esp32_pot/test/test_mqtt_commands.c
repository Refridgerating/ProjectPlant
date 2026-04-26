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

void test_parse_pump_override_command_with_request_id(void)
{
    const char *json = "{\"pump\":\"on\",\"duration_ms\":1500,\"requestId\":\"pump-1\"}";
    mqtt_command_t cmd = parse_command(json);

    TEST_ASSERT_EQUAL(MQTT_CMD_PUMP_OVERRIDE, cmd.type);
    TEST_ASSERT_TRUE(cmd.pump_on);
    TEST_ASSERT_EQUAL_UINT32(1500, cmd.duration_ms);
    TEST_ASSERT_EQUAL_STRING("pump-1", cmd.request_id);
}

void test_parse_ic_zone1_override_command(void)
{
    const char *json = "{\"icZone1\":\"on\",\"duration_ms\":4500,\"requestId\":\"ic1-1\"}";
    mqtt_command_t cmd = parse_command(json);

    TEST_ASSERT_EQUAL(MQTT_CMD_IC_ZONE1_OVERRIDE, cmd.type);
    TEST_ASSERT_TRUE(cmd.ic_zone1_on);
    TEST_ASSERT_EQUAL_UINT32(4500, cmd.duration_ms);
    TEST_ASSERT_EQUAL_STRING("ic1-1", cmd.request_id);
}

void test_parse_fan_override_command(void)
{
    const char *json = "{\"fan\":true,\"duration_ms\":2000,\"requestId\":\"fan-1\"}";
    mqtt_command_t cmd = parse_command(json);

    TEST_ASSERT_EQUAL(MQTT_CMD_FAN_OVERRIDE, cmd.type);
    TEST_ASSERT_TRUE(cmd.fan_on);
    TEST_ASSERT_EQUAL_UINT32(2000, cmd.duration_ms);
    TEST_ASSERT_EQUAL_STRING("fan-1", cmd.request_id);
}

void test_parse_mister_override_command(void)
{
    const char *json = "{\"mister\":\"off\",\"requestId\":\"mist-1\"}";
    mqtt_command_t cmd = parse_command(json);

    TEST_ASSERT_EQUAL(MQTT_CMD_MISTER_OVERRIDE, cmd.type);
    TEST_ASSERT_FALSE(cmd.mister_on);
    TEST_ASSERT_EQUAL_UINT32(0, cmd.duration_ms);
    TEST_ASSERT_EQUAL_STRING("mist-1", cmd.request_id);
}

void test_parse_light_override_command(void)
{
    const char *json = "{\"light\":\"on\",\"duration_ms\":6000,\"requestId\":\"light-1\"}";
    mqtt_command_t cmd = parse_command(json);

    TEST_ASSERT_EQUAL(MQTT_CMD_LIGHT_OVERRIDE, cmd.type);
    TEST_ASSERT_TRUE(cmd.light_on);
    TEST_ASSERT_EQUAL_UINT32(6000, cmd.duration_ms);
    TEST_ASSERT_EQUAL_STRING("light-1", cmd.request_id);
}

void test_parse_schedule_update_command(void)
{
    const char *json =
        "{"
        "\"requestId\":\"sched-1\","
        "\"tzOffsetMinutes\":-300,"
        "\"scheduleTimezonePosix\":\"EST5EDT,M3.2.0/2,M11.1.0/2\","
        "\"scheduleUpdatedAtMs\":1700000000000,"
        "\"schedule\":{"
        "\"light\":{\"enabled\":true,\"startTime\":\"06:00\",\"endTime\":\"20:00\"},"
        "\"pump\":{\"enabled\":false,\"startTime\":\"07:00\",\"endTime\":\"07:15\"},"
        "\"icZone1\":{\"enabled\":true,\"startTime\":\"08:00\",\"endTime\":\"08:30\"},"
        "\"mister\":{\"enabled\":false,\"startTime\":\"09:00\",\"endTime\":\"09:15\"},"
        "\"fan\":{\"enabled\":true,\"startTime\":\"10:00\",\"endTime\":\"18:00\"}"
        "}"
        "}";
    mqtt_command_t cmd = parse_command(json);

    TEST_ASSERT_EQUAL(MQTT_CMD_CONFIG_UPDATE, cmd.type);
    TEST_ASSERT_TRUE(cmd.has_schedule);
    TEST_ASSERT_EQUAL_STRING("sched-1", cmd.request_id);

    TEST_ASSERT_TRUE(cmd.schedule.light.enabled);
    TEST_ASSERT_EQUAL_UINT16(6 * 60, cmd.schedule.light.start_minute);
    TEST_ASSERT_EQUAL_UINT16(20 * 60, cmd.schedule.light.end_minute);

    TEST_ASSERT_FALSE(cmd.schedule.pump.enabled);
    TEST_ASSERT_EQUAL_UINT16(7 * 60, cmd.schedule.pump.start_minute);
    TEST_ASSERT_EQUAL_UINT16((7 * 60) + 15, cmd.schedule.pump.end_minute);

    TEST_ASSERT_TRUE(cmd.schedule.ic_zone1.enabled);
    TEST_ASSERT_EQUAL_UINT16(8 * 60, cmd.schedule.ic_zone1.start_minute);
    TEST_ASSERT_EQUAL_UINT16((8 * 60) + 30, cmd.schedule.ic_zone1.end_minute);

    TEST_ASSERT_FALSE(cmd.schedule.mister.enabled);
    TEST_ASSERT_EQUAL_UINT16(9 * 60, cmd.schedule.mister.start_minute);
    TEST_ASSERT_EQUAL_UINT16((9 * 60) + 15, cmd.schedule.mister.end_minute);

    TEST_ASSERT_TRUE(cmd.schedule.fan.enabled);
    TEST_ASSERT_EQUAL_UINT16(10 * 60, cmd.schedule.fan.start_minute);
    TEST_ASSERT_EQUAL_UINT16(18 * 60, cmd.schedule.fan.end_minute);

    TEST_ASSERT_EQUAL_INT16(-300, cmd.schedule.timezone_offset_minutes);
    TEST_ASSERT_EQUAL_STRING("EST5EDT,M3.2.0/2,M11.1.0/2", cmd.schedule.timezone_posix);
    TEST_ASSERT_EQUAL_UINT64(1700000000000ULL, cmd.schedule.updated_at_ms);
}

void test_schedule_minute_of_day_uses_posix_timezone_across_dst_boundaries(void)
{
    node_schedule_t schedule;
    node_schedule_defaults(&schedule);
    strncpy(schedule.timezone_posix, "EST5EDT,M3.2.0/2,M11.1.0/2", sizeof(schedule.timezone_posix) - 1);
    schedule.timezone_posix[sizeof(schedule.timezone_posix) - 1] = '\0';

    int minute = 0;
    TEST_ASSERT_TRUE(node_schedule_minute_of_day_from_epoch(&schedule, 1772953140LL, &minute));
    TEST_ASSERT_EQUAL_INT((1 * 60) + 59, minute);

    TEST_ASSERT_TRUE(node_schedule_minute_of_day_from_epoch(&schedule, 1772953200LL, &minute));
    TEST_ASSERT_EQUAL_INT(3 * 60, minute);

    TEST_ASSERT_TRUE(node_schedule_minute_of_day_from_epoch(&schedule, 1793512740LL, &minute));
    TEST_ASSERT_EQUAL_INT((1 * 60) + 59, minute);

    TEST_ASSERT_TRUE(node_schedule_minute_of_day_from_epoch(&schedule, 1793512800LL, &minute));
    TEST_ASSERT_EQUAL_INT(1 * 60, minute);
}

void test_schedule_minute_of_day_preserves_legacy_fixed_offset_behavior(void)
{
    node_schedule_t schedule;
    node_schedule_defaults(&schedule);
    schedule.timezone_offset_minutes = -300;

    int minute = 0;
    TEST_ASSERT_TRUE(node_schedule_minute_of_day_from_epoch(&schedule, 1773658800LL, &minute));
    TEST_ASSERT_EQUAL_INT(6 * 60, minute);
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
    RUN_TEST(test_parse_pump_override_command_with_request_id);
    RUN_TEST(test_parse_ic_zone1_override_command);
    RUN_TEST(test_parse_fan_override_command);
    RUN_TEST(test_parse_mister_override_command);
    RUN_TEST(test_parse_light_override_command);
    RUN_TEST(test_parse_schedule_update_command);
    RUN_TEST(test_schedule_minute_of_day_uses_posix_timezone_across_dst_boundaries);
    RUN_TEST(test_schedule_minute_of_day_preserves_legacy_fixed_offset_behavior);
    RUN_TEST(test_parse_ignores_invalid_json);
    RUN_TEST(test_parse_truncates_long_request_id);
    UNITY_END();
}
