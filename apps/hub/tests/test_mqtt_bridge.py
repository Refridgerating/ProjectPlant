import json

import pytest

from mqtt.bridge import build_sensor_payload


def _encode(payload: dict) -> bytes:
    return json.dumps(payload).encode("utf-8")


def test_build_sensor_payload_normalizes_fields():
    payload = {
        "soil_pct": 56.789,
        "temperature_c": 21.345,
        "humidity_pct": 48.123,
        "pump_on": True,
        "timestamp_ms": 1_700_000_000_000,
        "requestId": "req-123",
    }
    normalized = build_sensor_payload(_encode(payload), "pot-abc")
    assert normalized is not None
    data = normalized.to_dict()
    assert data["potId"] == "pot-abc"
    assert data["moisture"] == pytest.approx(56.8)
    assert data["temperature"] == pytest.approx(21.3)
    assert data["humidity"] == pytest.approx(48.1)
    assert data["valveOpen"] is True
    assert data["timestamp"].endswith("Z")
    assert data["requestId"] == "req-123"


def test_build_sensor_payload_accepts_strings_and_defaults():
    payload = {
        "soil_pct": "34.44",
        "temperature_c": "",
        "pump_on": "off",
        "request_id": " legacy-req ",
    }
    normalized = build_sensor_payload(_encode(payload), "pot-xyz")
    assert normalized is not None
    data = normalized.to_dict()
    assert data["moisture"] == pytest.approx(34.4)
    assert data["temperature"] == 0.0  # default when missing
    assert data["valveOpen"] is False
    assert data["requestId"] == "legacy-req"


def test_build_sensor_payload_returns_none_when_unusable():
    normalized = build_sensor_payload(_encode({"ignored": True}), "pot-123")
    assert normalized is None


def test_build_sensor_payload_handles_invalid_json():
    normalized = build_sensor_payload(b"not-json", "pot-123")
    assert normalized is None
