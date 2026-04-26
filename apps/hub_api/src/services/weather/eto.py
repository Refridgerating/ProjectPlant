from __future__ import annotations

from datetime import datetime
from typing import Iterable, Sequence

from care_engine.evapotranspiration import (
    ClimateSample,
    PenmanMonteithResult,
    PlantParams,
    PotParams,
    compute_penman_monteith,
)

from .schemas import WeatherSample


def weather_samples_to_climate(samples: Iterable[WeatherSample | dict[str, object]]) -> list[ClimateSample]:
    climate_samples: list[ClimateSample] = []
    for sample in samples:
        payload = sample.to_payload() if isinstance(sample, WeatherSample) else sample
        timestamp = _parse_timestamp(payload.get("timestamp"))
        if timestamp is None:
            continue
        climate_samples.append(
            ClimateSample(
                timestamp=timestamp,
                temperature_c=_optional_float(payload.get("temperature_c")),
                humidity_pct=_optional_float(payload.get("humidity_pct")),
                pressure_hpa=_optional_float(payload.get("pressure_hpa")),
                solar_radiation_w_m2=_optional_float(payload.get("solar_radiation_w_m2")),
                wind_speed_m_s=_optional_float(payload.get("wind_speed_m_s")),
            )
        )
    return climate_samples


def estimate_reference_et(
    samples: Sequence[WeatherSample | dict[str, object]],
    plant: PlantParams,
    pot: PotParams,
    *,
    lookback_hours: float,
    assumed_wind_speed_m_s: float = 0.1,
    net_radiation_factor: float = 0.75,
) -> PenmanMonteithResult:
    return compute_penman_monteith(
        weather_samples_to_climate(samples),
        plant,
        pot,
        lookback_hours=lookback_hours,
        assumed_wind_speed_m_s=assumed_wind_speed_m_s,
        net_radiation_factor=net_radiation_factor,
    )


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _optional_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
