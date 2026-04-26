from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from device_protocol.topics import (
    CANONICAL_SENSOR_FILTER,
    CANONICAL_STATUS_FILTER,
    DEVICE_STATE_FILTER,
    IRRIGATION_CMD_TOPIC_FMT,
    METRICS_TOPIC_FMT,
    MQTT_PING_TOPIC,
    PLANT_TELEMETRY_FILTER,
    command_topic,
    device_state_topic,
    et_metrics_topic,
    irrigation_command_topic,
    legacy_status_topic,
    legacy_telemetry_topic,
    plant_telemetry_topic,
    sensor_topic,
    status_topic,
)


def test_canonical_topic_helpers() -> None:
    assert command_topic("pot-a") == "pots/pot-a/command"
    assert sensor_topic("pot-a") == "pots/pot-a/sensors"
    assert status_topic("pot-a") == "pots/pot-a/status"
    assert CANONICAL_SENSOR_FILTER == "pots/+/sensors"
    assert CANONICAL_STATUS_FILTER == "pots/+/status"
    assert legacy_telemetry_topic("pot-a") == "projectplant/pots/pot-a/telemetry"
    assert legacy_status_topic("pot-a") == "projectplant/pots/pot-a/status"
    assert device_state_topic("device-a") == "plant/device-a/state"
    assert plant_telemetry_topic("plant-a") == "plant/plant-a/telemetry"
    assert et_metrics_topic("plant-a") == "plant/plant-a/et/metrics"
    assert irrigation_command_topic("plant-a") == "plant/plant-a/irrigation/cmd"
    assert DEVICE_STATE_FILTER == "plant/+/state"
    assert PLANT_TELEMETRY_FILTER == "plant/+/telemetry"
    assert METRICS_TOPIC_FMT == "plant/{plant_id}/et/metrics"
    assert IRRIGATION_CMD_TOPIC_FMT == "plant/{plant_id}/irrigation/cmd"
    assert MQTT_PING_TOPIC == "lab/ping"
