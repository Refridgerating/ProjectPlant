from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

ACTUATOR_FIELDS = {"pump", "icZone1", "ic_zone1", "fan", "mister", "light"}
COMMAND_FIELDS = {
    "action",
    "command",
    "pump",
    "icZone1",
    "ic_zone1",
    "fan",
    "mister",
    "light",
    "deviceName",
    "displayName",
    "sensorMode",
    "sensor_mode",
    "sensorsEnabled",
    "schedule",
}
SCHEDULE_TARGETS = ("light", "pump", "icZone1", "ic_zone1", "mister", "fan")


class ProtocolPayloadError(ValueError):
    """Raised when an MQTT payload violates the ProjectPlant device contract."""


def schema_dir() -> Path | None:
    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "protocol" / "schemas"
        if candidate.exists():
            return candidate
    return None


def load_schema(name: str) -> dict[str, Any]:
    root = schema_dir()
    if root is None:
        raise FileNotFoundError("packages/protocol/schemas could not be located")
    with (root / name).open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ProtocolPayloadError(f"{name} is not a JSON object schema")
    return payload


def sensor_read_command(*, request_id: str) -> dict[str, Any]:
    return _validated_command({"requestId": _require_request_id(request_id), "command": "sensor_read"})


def actuator_command(
    actuator: str,
    *,
    request_id: str,
    on: bool,
    duration_ms: int | None = None,
) -> dict[str, Any]:
    if actuator not in ACTUATOR_FIELDS:
        raise ProtocolPayloadError(f"Unsupported actuator field: {actuator}")
    payload: dict[str, Any] = {"requestId": _require_request_id(request_id), actuator: "on" if on else "off"}
    if duration_ms is not None:
        duration = int(duration_ms)
        if duration < 0:
            raise ProtocolPayloadError("duration_ms must be non-negative")
        payload["duration_ms"] = duration
    return _validated_command(payload)


def device_name_command(*, request_id: str, name: str) -> dict[str, Any]:
    cleaned = name.strip()
    if not cleaned:
        raise ProtocolPayloadError("deviceName is required")
    if len(cleaned) > 32:
        raise ProtocolPayloadError("deviceName must be 32 characters or fewer")
    return _validated_command({"requestId": _require_request_id(request_id), "deviceName": cleaned})


def sensor_mode_command(*, request_id: str, mode: str) -> dict[str, Any]:
    normalized = _normalize_sensor_mode(mode)
    return _validated_command({"requestId": _require_request_id(request_id), "sensorMode": normalized})


def schedule_command(
    *,
    request_id: str,
    schedule: Mapping[str, Any],
    tz_offset_minutes: int | None = None,
    schedule_timezone_posix: str | None = None,
    schedule_updated_at_ms: int | None = None,
) -> dict[str, Any]:
    if not isinstance(schedule, Mapping):
        raise ProtocolPayloadError("schedule must be an object")
    payload: dict[str, Any] = {"requestId": _require_request_id(request_id), "schedule": dict(schedule)}
    validate_device_schedule_payload(payload["schedule"])
    if tz_offset_minutes is not None:
        payload["tzOffsetMinutes"] = int(tz_offset_minutes)
    if isinstance(schedule_timezone_posix, str) and schedule_timezone_posix.strip():
        payload["scheduleTimezonePosix"] = schedule_timezone_posix.strip()
    if schedule_updated_at_ms is not None:
        value = int(schedule_updated_at_ms)
        if value < 0:
            raise ProtocolPayloadError("scheduleUpdatedAtMs must be non-negative")
        payload["scheduleUpdatedAtMs"] = value
    return _validated_command(payload)


def validate_device_command_payload(payload: Mapping[str, Any]) -> bool:
    if not isinstance(payload, Mapping):
        raise ProtocolPayloadError("command payload must be an object")
    if not any(key in payload for key in COMMAND_FIELDS):
        raise ProtocolPayloadError("command payload must include a command field")
    request_id = payload.get("requestId") or payload.get("request_id")
    if request_id is not None and not _valid_request_id(request_id):
        raise ProtocolPayloadError("requestId must be a non-empty string up to 63 characters")
    duration = payload.get("duration_ms")
    if duration is not None and (not isinstance(duration, int) or duration < 0):
        raise ProtocolPayloadError("duration_ms must be a non-negative integer")
    for field in ACTUATOR_FIELDS:
        if field in payload and not _valid_actuator_value(payload[field]):
            raise ProtocolPayloadError(f"{field} must be boolean or 'on'/'off'")
    action = payload.get("action")
    command = payload.get("command")
    for key, value in (("action", action), ("command", command)):
        if value is not None and value not in {"sensor_read", "sensorRead"}:
            raise ProtocolPayloadError(f"{key} must be sensor_read or sensorRead")
    if "schedule" in payload:
        validate_device_schedule_payload(payload["schedule"])
    return True


def validate_device_schedule_payload(payload: Any) -> bool:
    if not isinstance(payload, Mapping):
        raise ProtocolPayloadError("schedule must be an object")
    for target in SCHEDULE_TARGETS:
        if target not in payload:
            continue
        timer = payload[target]
        if not isinstance(timer, Mapping):
            raise ProtocolPayloadError(f"schedule.{target} must be an object")
        if not isinstance(timer.get("enabled"), bool):
            raise ProtocolPayloadError(f"schedule.{target}.enabled must be boolean")
        for field in ("startTime", "endTime"):
            value = timer.get(field)
            if not isinstance(value, str) or not _valid_hhmm(value):
                raise ProtocolPayloadError(f"schedule.{target}.{field} must be HH:MM")
    return True


def validate_device_sensor_payload(payload: Mapping[str, Any]) -> bool:
    required = {
        "potId": str,
        "moisture": (int, float),
        "temperature": (int, float),
        "valveOpen": bool,
        "timestamp": str,
    }
    _validate_required_types(payload, required, "sensor")
    return True


def validate_device_status_payload(payload: Mapping[str, Any]) -> bool:
    if not isinstance(payload, Mapping):
        raise ProtocolPayloadError("status payload must be an object")
    meaningful = {
        "status",
        "state",
        "requestId",
        "request_id",
        "pumpOn",
        "pump_on",
        "pump",
        "icZone1On",
        "ic_zone1_on",
        "fanOn",
        "fan_on",
        "misterOn",
        "mister_on",
        "lightOn",
        "light_on",
        "deviceName",
        "displayName",
        "sensorMode",
        "sensor_mode",
        "schedule",
        "scheduleTimezonePosix",
        "tzOffsetMinutesCurrent",
        "timestamp",
        "timestampMs",
    }
    if not any(key in payload for key in meaningful):
        raise ProtocolPayloadError("status payload does not contain recognized fields")
    if "schedule" in payload:
        validate_device_schedule_payload(payload["schedule"])
    return True


def encode_json_payload(payload: Mapping[str, Any]) -> str:
    return json.dumps(dict(payload), separators=(",", ":"))


def _validated_command(payload: dict[str, Any]) -> dict[str, Any]:
    validate_device_command_payload(payload)
    return payload


def _require_request_id(request_id: str) -> str:
    if not _valid_request_id(request_id):
        raise ProtocolPayloadError("requestId must be a non-empty string up to 63 characters")
    return request_id


def _valid_request_id(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 63


def _valid_actuator_value(value: Any) -> bool:
    return isinstance(value, bool) or value in {"on", "off"}


def _normalize_sensor_mode(mode: str) -> str:
    cleaned = mode.strip().lower()
    if cleaned in {"control_only", "control-only", "control"}:
        return "control_only"
    if cleaned in {"full", "sensors", "enabled"}:
        return "full"
    raise ProtocolPayloadError("sensorMode must be 'full' or 'control_only'")


def _valid_hhmm(value: str) -> bool:
    if len(value) != 5 or value[2] != ":":
        return False
    try:
        hour = int(value[:2])
        minute = int(value[3:])
    except ValueError:
        return False
    return 0 <= hour <= 23 and 0 <= minute <= 59


def _validate_required_types(payload: Mapping[str, Any], required: Mapping[str, Any], label: str) -> None:
    if not isinstance(payload, Mapping):
        raise ProtocolPayloadError(f"{label} payload must be an object")
    for key, expected_type in required.items():
        if key not in payload:
            raise ProtocolPayloadError(f"{label} payload missing {key}")
        if not isinstance(payload[key], expected_type):
            raise ProtocolPayloadError(f"{label} payload field {key} has invalid type")
