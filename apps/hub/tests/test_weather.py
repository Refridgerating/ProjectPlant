import httpx
import respx
from datetime import datetime, timedelta, timezone
from fastapi.testclient import TestClient

from main import create_app

app = create_app()
client = TestClient(app)

POINTS_URL = "https://api.weather.gov/points/38.9072,-77.0369"
STATIONS_URL = "https://api.weather.gov/stations"
OBS_URL = "https://api.weather.gov/stations/KDCA/observations"
OBS_PAGE2_URL = "https://api.weather.gov/stations/KDCA/observations?cursor=token"


def _iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")

@respx.mock
def test_weather_endpoint_success():
    now = datetime.now(timezone.utc)
    ts_recent = _iso(now - timedelta(minutes=10))
    ts_earlier = _iso(now - timedelta(hours=1, minutes=40))

    respx.get(POINTS_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "properties": {
                    "observationStations": STATIONS_URL,
                }
            },
        )
    )

    respx.get(STATIONS_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "features": [
                    {"id": "https://api.weather.gov/stations/KDCA"},
                ]
            },
        )
    )

    respx.get(OBS_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "features": [
                    {
                        "properties": {
                            "timestamp": ts_recent,
                            "station": "https://api.weather.gov/stations/KDCA",
                            "temperature": {"value": 23.4},
                            "relativeHumidity": {"value": 64.2},
                            "barometricPressure": {"value": 100900},
                            "solarRadiation": {"value": 510.0},
                        }
                    }
                ],
                "pagination": {"next": OBS_PAGE2_URL},
            },
        )
    )

    respx.get(OBS_PAGE2_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "features": [
                    {
                        "properties": {
                            "timestamp": ts_earlier,
                            "station": "https://api.weather.gov/stations/KDCA",
                            "temperature": {"value": 22.1},
                            "relativeHumidity": {"value": 66.0},
                            "barometricPressure": {"value": 100500},
                            "solarRadiation": {"value": 400.0},
                        }
                    }
                ],
                "pagination": {},
            },
        )
    )

    response = client.get(
        "/api/v1/weather/local",
        params={"lat": 38.9072, "lon": -77.0369, "hours": 2},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["location"] == {"lat": 38.9072, "lon": -77.0369}
    assert payload["requested_hours"] == 2
    assert payload["coverage_hours"] >= 1.5
    assert payload["available_windows"] == [0.5, 1, 2]
    assert len(payload["data"]) == 2

@respx.mock
def test_weather_endpoint_upstream_failure():
    respx.get(POINTS_URL).mock(return_value=httpx.Response(500))
    response = client.get("/api/v1/weather/local", params={"lat": 38.9, "lon": -77.0})
    assert response.status_code in {500, 502}
