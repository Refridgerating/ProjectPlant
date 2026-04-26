from __future__ import annotations

COMMAND_TOPIC_FMT = "pots/{pot_id}/command"
SENSORS_TOPIC_FMT = "pots/{pot_id}/sensors"
STATUS_TOPIC_FMT = "pots/{pot_id}/status"

LEGACY_FIRMWARE_TELEMETRY_FILTER = "projectplant/pots/+/telemetry"
LEGACY_FIRMWARE_STATUS_FILTER = "projectplant/pots/+/status"
CANONICAL_COMMAND_FILTER = "pots/+/command"
CANONICAL_SENSOR_TOPIC_FMT = SENSORS_TOPIC_FMT
CANONICAL_SENSOR_FILTER = "pots/+/sensors"
CANONICAL_STATUS_TOPIC_FMT = STATUS_TOPIC_FMT
CANONICAL_STATUS_FILTER = "pots/+/status"
DEVICE_STATE_FILTER = "plant/+/state"
PLANT_TELEMETRY_FILTER = "plant/+/telemetry"
METRICS_TOPIC_FMT = "plant/{plant_id}/et/metrics"
IRRIGATION_CMD_TOPIC_FMT = "plant/{plant_id}/irrigation/cmd"
MQTT_PING_TOPIC = "lab/ping"


def command_topic(pot_id: str) -> str:
    return COMMAND_TOPIC_FMT.format(pot_id=pot_id)


def sensor_topic(pot_id: str) -> str:
    return SENSORS_TOPIC_FMT.format(pot_id=pot_id)


def status_topic(pot_id: str) -> str:
    return STATUS_TOPIC_FMT.format(pot_id=pot_id)


def legacy_telemetry_topic(pot_id: str) -> str:
    return f"projectplant/pots/{pot_id}/telemetry"


def legacy_status_topic(pot_id: str) -> str:
    return f"projectplant/pots/{pot_id}/status"


def device_state_topic(device_id: str) -> str:
    return f"plant/{device_id}/state"


def plant_telemetry_topic(plant_id: str) -> str:
    return f"plant/{plant_id}/telemetry"


def et_metrics_topic(plant_id: str) -> str:
    return METRICS_TOPIC_FMT.format(plant_id=plant_id)


def irrigation_command_topic(plant_id: str) -> str:
    return IRRIGATION_CMD_TOPIC_FMT.format(plant_id=plant_id)
