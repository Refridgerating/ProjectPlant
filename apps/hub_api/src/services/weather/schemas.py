from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass(slots=True)
class WeatherSample:
    timestamp: str | None = None
    station: str | None = None
    temperature_c: float | None = None
    temperature_max_c: float | None = None
    temperature_min_c: float | None = None
    dewpoint_c: float | None = None
    humidity_pct: float | None = None
    specific_humidity_g_kg: float | None = None
    pressure_hpa: float | None = None
    pressure_kpa: float | None = None
    solar_radiation_mj_m2_h: float | None = None
    solar_radiation_clear_mj_m2_h: float | None = None
    solar_radiation_diffuse_mj_m2_h: float | None = None
    solar_radiation_direct_mj_m2_h: float | None = None
    solar_radiation_w_m2: float | None = None
    wind_speed_m_s: float | None = None
    precip_mm_h: float | None = None
    source: str | None = None

    def to_payload(self) -> dict[str, object]:
        return {
            "timestamp": self.timestamp,
            "station": self.station,
            "temperature_c": self.temperature_c,
            "temperature_max_c": self.temperature_max_c,
            "temperature_min_c": self.temperature_min_c,
            "dewpoint_c": self.dewpoint_c,
            "humidity_pct": self.humidity_pct,
            "specific_humidity_g_kg": self.specific_humidity_g_kg,
            "pressure_hpa": self.pressure_hpa,
            "pressure_kpa": self.pressure_kpa,
            "solar_radiation_mj_m2_h": self.solar_radiation_mj_m2_h,
            "solar_radiation_clear_mj_m2_h": self.solar_radiation_clear_mj_m2_h,
            "solar_radiation_diffuse_mj_m2_h": self.solar_radiation_diffuse_mj_m2_h,
            "solar_radiation_direct_mj_m2_h": self.solar_radiation_direct_mj_m2_h,
            "solar_radiation_w_m2": self.solar_radiation_w_m2,
            "wind_speed_m_s": self.wind_speed_m_s,
            "precip_mm_h": self.precip_mm_h,
            "source": self.source,
        }


@dataclass(slots=True)
class WeatherStationInfo:
    id: str | None = None
    name: str | None = None
    identifier: str | None = None
    lat: float | None = None
    lon: float | None = None
    distance_km: float | None = None

    def to_payload(self) -> dict[str, object]:
        return {
            "id": self.id,
            "name": self.name,
            "identifier": self.identifier,
            "lat": self.lat,
            "lon": self.lon,
            "distance_km": self.distance_km,
        }


@dataclass(slots=True)
class WeatherSeries:
    location: dict[str, float]
    requested_hours: float
    coverage_hours: float
    available_windows: list[float]
    data: list[WeatherSample]
    station: WeatherStationInfo | None = None
    sources: list[str] = field(default_factory=list)
    blend_mode: Literal["station", "station_hrrr_solar", "hrrr"] = "station"
    hrrr_used: bool = False
    hrrr_error: str | None = None

    def to_payload(self) -> dict[str, object]:
        return {
            "location": self.location,
            "requested_hours": self.requested_hours,
            "coverage_hours": self.coverage_hours,
            "available_windows": self.available_windows,
            "data": [entry.to_payload() for entry in self.data],
            "station": self.station.to_payload() if self.station is not None else None,
            "sources": self.sources,
            "blend_mode": self.blend_mode,
            "hrrr_used": self.hrrr_used,
            "hrrr_error": self.hrrr_error,
        }
