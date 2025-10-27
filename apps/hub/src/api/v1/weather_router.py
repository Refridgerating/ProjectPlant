import httpx
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from services.weather import weather_service

router = APIRouter(prefix="/weather", tags=["weather"])

ALLOWED_WINDOWS = [0.5, 1, 2, 6, 12, 24, 48]

def validate_lat(lat: float = Query(..., ge=-90.0, le=90.0)) -> float:
    return lat

def validate_lon(lon: float = Query(..., ge=-180.0, le=180.0)) -> float:
    return lon

def validate_hours(hours: float = Query(6.0, description="Lookback window in hours")) -> float:
    if hours not in ALLOWED_WINDOWS:
        raise HTTPException(status_code=400, detail="Unsupported hours window")
    return hours

class WeatherTelemetry(BaseModel):
    timestamp: str | None = None
    station: str | None = None
    temperature_c: float | None = Field(default=None, description="Ambient temperature in degC")
    temperature_max_c: float | None = Field(default=None, description="Hourly maximum temperature in degC (NASA POWER)")
    temperature_min_c: float | None = Field(default=None, description="Hourly minimum temperature in degC (NASA POWER)")
    dewpoint_c: float | None = Field(default=None, description="Dew point temperature in degC")
    humidity_pct: float | None = Field(default=None, description="Relative humidity %")
    specific_humidity_g_kg: float | None = Field(default=None, description="Specific humidity in g/kg derived from NASA POWER")
    pressure_hpa: float | None = Field(default=None, description="Barometric pressure in hPa")
    pressure_kpa: float | None = Field(default=None, description="Barometric pressure in kPa (NASA POWER)")
    solar_radiation_mj_m2_h: float | None = Field(default=None, description="Shortwave solar radiation in MJ/m^2/h (NASA POWER)")
    solar_radiation_clear_mj_m2_h: float | None = Field(default=None, description="Clear sky shortwave radiation in MJ/m^2/h (NASA POWER)")
    solar_radiation_diffuse_mj_m2_h: float | None = Field(default=None, description="Diffuse shortwave radiation in MJ/m^2/h (NASA POWER)")
    solar_radiation_direct_mj_m2_h: float | None = Field(default=None, description="Direct shortwave radiation in MJ/m^2/h (NASA POWER)")
    solar_radiation_w_m2: float | None = Field(default=None, description="Solar radiation in W/m^2")
    wind_speed_m_s: float | None = Field(default=None, description="Wind speed in m/s at observation height")
    precip_mm_h: float | None = Field(default=None, description="Precipitation rate in mm/h (NASA POWER)")
    source: str | None = Field(default=None, description="Comma-delimited data sources contributing to this record")

class WeatherStation(BaseModel):
    id: str | None = None
    name: str | None = None
    identifier: str | None = None
    lat: float | None = None
    lon: float | None = None
    distance_km: float | None = Field(default=None, description="Distance from requested location in kilometers")


class WeatherResponse(BaseModel):
    location: dict[str, float]
    requested_hours: float
    coverage_hours: float
    available_windows: list[float]
    data: list[WeatherTelemetry]
    station: WeatherStation | None = None
    sources: list[str] = Field(default_factory=list, description="Unique data providers contributing to this series")

@router.get("/local", response_model=WeatherResponse)
async def get_local_weather(
    lat: float = Depends(validate_lat),
    lon: float = Depends(validate_lon),
    hours: float = Depends(validate_hours),
):
    try:
        payload, station_info = await weather_service.get_observations(lat, lon, hours)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=exc.response.status_code, detail="Upstream weather service error") from exc
    except Exception as exc:  # noqa: B902
        raise HTTPException(status_code=502, detail=str(exc))

    coverage_hours = _calculate_coverage_hours(payload)
    max_window = max(coverage_hours, ALLOWED_WINDOWS[0])
    available_windows = [window for window in ALLOWED_WINDOWS if window <= max_window + 0.1]
    if not available_windows:
        available_windows = [ALLOWED_WINDOWS[0]]

    telemetry = [WeatherTelemetry(**entry) for entry in payload]
    station_payload = WeatherStation(**station_info) if station_info else None
    sources = sorted(
        {
            part.strip()
            for entry in payload
            for part in (entry.get("source") or "").split(",")
            if part and part.strip()
        }
    )
    return WeatherResponse(
        location={"lat": lat, "lon": lon},
        requested_hours=hours,
        coverage_hours=coverage_hours,
        available_windows=available_windows,
        data=telemetry,
        station=station_payload,
        sources=sources,
    )

def _calculate_coverage_hours(observations: list[dict[str, object]]) -> float:
    timestamps: list[datetime] = []
    for entry in observations:
        value = entry.get("timestamp")
        if isinstance(value, str):
            try:
                timestamps.append(datetime.fromisoformat(value.replace("Z", "+00:00")))
            except ValueError:
                continue
    if len(timestamps) < 2:
        return 0.0
    timestamps.sort()
    delta = timestamps[-1] - timestamps[0]
    return round(delta.total_seconds() / 3600.0, 2)
