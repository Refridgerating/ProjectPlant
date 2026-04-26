from __future__ import annotations

import pytest

from device_protocol.payloads import (
    ProtocolPayloadError,
    actuator_command,
    device_name_command,
    encode_json_payload,
    schedule_command,
    sensor_mode_command,
    sensor_read_command,
    validate_device_command_payload,
    validate_device_sensor_payload,
    validate_device_status_payload,
)


def test_command_builders_emit_current_wire_shapes() -> None:
    assert sensor_read_command(request_id="req-1") == {"requestId": "req-1", "command": "sensor_read"}
    assert actuator_command("pump", request_id="req-2", on=True, duration_ms=1500) == {
        "requestId": "req-2",
        "pump": "on",
        "duration_ms": 1500,
    }
    assert device_name_command(request_id="req-3", name="Window Basil") == {
        "requestId": "req-3",
        "deviceName": "Window Basil",
    }
    assert sensor_mode_command(request_id="req-4", mode="control-only") == {
        "requestId": "req-4",
        "sensorMode": "control_only",
    }


def test_schedule_command_validates_timer_shape() -> None:
    payload = schedule_command(
        request_id="sched-1",
        schedule={
            "light": {"enabled": True, "startTime": "06:00", "endTime": "20:00"},
            "pump": {"enabled": False, "startTime": "07:00", "endTime": "07:15"},
        },
        tz_offset_minutes=-300,
        schedule_timezone_posix="EST5EDT,M3.2.0/2,M11.1.0/2",
        schedule_updated_at_ms=1700000000000,
    )

    assert payload["requestId"] == "sched-1"
    assert payload["tzOffsetMinutes"] == -300
    assert payload["scheduleUpdatedAtMs"] == 1700000000000
    assert encode_json_payload(payload).startswith('{"requestId":"sched-1"')


def test_validators_accept_current_sensor_and_status_payloads() -> None:
    assert validate_device_sensor_payload(
        {
            "potId": "pot-a",
            "moisture": 56.8,
            "temperature": 21.3,
            "valveOpen": True,
            "timestamp": "2023-11-14T22:13:20.000Z",
        }
    )
    assert validate_device_status_payload({"status": "pump_on", "requestId": "req-1"})


def test_invalid_command_payloads_raise() -> None:
    with pytest.raises(ProtocolPayloadError):
        validate_device_command_payload({"requestId": "req-only"})
    with pytest.raises(ProtocolPayloadError):
        actuator_command("pump", request_id="req-1", on=True, duration_ms=-1)
    with pytest.raises(ProtocolPayloadError):
        schedule_command(
            request_id="req-1",
            schedule={"light": {"enabled": True, "startTime": "6am", "endTime": "20:00"}},
        )
