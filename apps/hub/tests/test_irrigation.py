from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from config import settings
from main import create_app
from services.evapotranspiration import ClimateSample, PlantParams, PotParams, compute_penman_monteith


@pytest.fixture
def disable_mqtt():
    original = settings.mqtt_enabled
    settings.mqtt_enabled = False
    try:
        yield
    finally:
        settings.mqtt_enabled = original


def _sample_series() -> list[ClimateSample]:
    base = datetime(2024, 3, 1, 8, tzinfo=timezone.utc)
    return [
        ClimateSample(
            timestamp=base,
            temperature_c=23.5,
            humidity_pct=55.0,
            pressure_hpa=1012.0,
            solar_radiation_w_m2=120.0,
            wind_speed_m_s=0.15,
        ),
        ClimateSample(
            timestamp=base + timedelta(hours=12),
            temperature_c=24.0,
            humidity_pct=58.0,
            pressure_hpa=1011.5,
            solar_radiation_w_m2=180.0,
            wind_speed_m_s=0.12,
        ),
        ClimateSample(
            timestamp=base + timedelta(hours=24),
            temperature_c=22.8,
            humidity_pct=60.0,
            pressure_hpa=1010.8,
            solar_radiation_w_m2=90.0,
            wind_speed_m_s=0.1,
        ),
    ]


def test_compute_penman_monteith_outputs_positive():
    samples = _sample_series()
    plant = PlantParams(crop_coefficient=0.85, name="Test Plant")
    pot = PotParams(
        diameter_cm=25.0,
        height_cm=22.0,
        available_water_fraction=0.35,
        irrigation_efficiency=0.9,
        target_refill_fraction=0.4,
    )

    result = compute_penman_monteith(
        samples=samples,
        plant=plant,
        pot=pot,
        lookback_hours=24.0,
        assumed_wind_speed_m_s=0.12,
    )

    assert result.outputs.et0_mm_day > 0
    assert result.outputs.etc_mm_day > 0
    assert result.outputs.daily_water_liters > 0
    assert result.pot_metrics.surface_area_m2 > 0
    assert result.pot_metrics.available_water_liters > 0
    assert 20 <= result.climate.coverage_hours <= 30


def test_irrigation_endpoint_returns_recommendation(disable_mqtt):
    app = create_app()
    samples = _sample_series()
    payload = {
        "method": "penman_monteith",
        "lookback_hours": 24,
        "samples": [
            {
                "timestamp": sample.timestamp.isoformat(),
                "temperature_c": sample.temperature_c,
                "humidity_pct": sample.humidity_pct,
                "pressure_hpa": sample.pressure_hpa,
                "solar_radiation_w_m2": sample.solar_radiation_w_m2,
                "wind_speed_m_s": sample.wind_speed_m_s,
            }
            for sample in samples
        ],
        "plant": {"name": "Monstera", "crop_coefficient": 0.9},
        "pot": {
            "diameter_cm": 26,
            "height_cm": 24,
            "available_water_fraction": 0.4,
            "irrigation_efficiency": 0.88,
            "target_refill_fraction": 0.5,
        },
    }

    with TestClient(app) as client:
        response = client.post("/api/v1/irrigation/estimate", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["method"] == "penman_monteith"
    outputs = body["outputs"]
    assert outputs["et0_mm_day"] > 0
    assert outputs["recommended_ml_per_event"] > 0
    assert "diagnostics" in body
    assert isinstance(body["diagnostics"].get("notes", []), list)