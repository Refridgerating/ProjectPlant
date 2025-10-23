
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

POINTS_URL = "https://api.weather.gov/points/38.9072,-77.0369"
STATIONS_URL = "https://api.weather.gov/stations"
OBS_URL = "https://api.weather.gov/stations/KDCA/observations"


def _timestamp(minutes_ago: float) -> str:
    ts = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return ts.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def test_weather_endpoint_success(client: TestClient, respx_mock) -> None:
    respx_mock.get(POINTS_URL).mock(
        return_value=httpx.Response(
            200,
            json={"properties": {"observationStations": STATIONS_URL}},
        )
    )

    respx_mock.get(STATIONS_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "features": [
                    {
                        "id": "https://api.weather.gov/stations/KDCA",
                        "properties": {
                            "name": "Ronald Reagan National",
                            "stationIdentifier": "KDCA",
                        },
                        "geometry": {"type": "Point", "coordinates": [-77.0369, 38.8512]},
                    }
                ]
            },
        )
    )

    respx_mock.get(OBS_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "features": [
                    {
                        "properties": {
                            "timestamp": _timestamp(10),
                            "station": "https://api.weather.gov/stations/KDCA",
                            "temperature": {"value": 22.0},
                            "relativeHumidity": {"value": 60.0},
                            "barometricPressure": {"value": 100800},
                            "solarRadiation": {"value": 420.0},
                            "windSpeed": {"value": 18.0, "unitCode": "wmoUnit:km_h-1"},
                        }
                    }
                ]
            },
        )
    )

    response = client.get(
        "/api/v1/weather/local",
        params={"lat": 38.9072, "lon": -77.0369, "hours": 1},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["requested_hours"] == 1
    assert payload["station"]["identifier"] == "KDCA"
    assert payload["station"]["name"] == "Ronald Reagan National"
    assert payload["station"]["distance_km"] == pytest.approx(6.227, abs=0.05)
    assert payload["data"], "should include at least one observation"
    entry = payload["data"][0]
    assert entry["wind_speed_m_s"] is not None
    assert entry["wind_speed_m_s"] == pytest.approx(5.0)


def test_weather_endpoint_upstream_failure(client: TestClient, respx_mock) -> None:
    respx_mock.get(POINTS_URL).mock(return_value=httpx.Response(500))

    response = client.get("/api/v1/weather/local", params={"lat": 38.9, "lon": -77.0})
    assert response.status_code in {500, 502}
