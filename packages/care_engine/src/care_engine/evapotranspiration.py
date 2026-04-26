from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Sequence


@dataclass(slots=True)
class ClimateSample:
    timestamp: datetime
    temperature_c: float | None
    humidity_pct: float | None
    pressure_hpa: float | None
    solar_radiation_w_m2: float | None
    wind_speed_m_s: float | None = None


@dataclass(slots=True)
class PlantParams:
    crop_coefficient: float
    name: str | None = None


@dataclass(slots=True)
class PotParams:
    diameter_cm: float
    height_cm: float
    available_water_fraction: float
    irrigation_efficiency: float
    target_refill_fraction: float


@dataclass(slots=True)
class PotMetrics:
    surface_area_m2: float
    volume_liters: float
    available_water_liters: float
    max_event_liters: float


@dataclass(slots=True)
class ClimateSummary:
    coverage_hours: float
    data_points: int
    avg_temperature_c: float
    avg_humidity_pct: float
    avg_pressure_hpa: float
    avg_solar_w_m2: float
    wind_speed_m_s: float
    net_radiation_mj_m2_day: float


@dataclass(slots=True)
class IrrigationOutputs:
    et0_mm_day: float
    etc_mm_day: float
    daily_water_liters: float
    adjusted_daily_liters: float
    recommended_events_per_day: float
    recommended_ml_per_event: float
    recommended_ml_per_day: float


@dataclass(slots=True)
class Assumptions:
    lookback_hours: float
    assumed_wind_speed_m_s: float
    net_radiation_factor: float


@dataclass(slots=True)
class PenmanMonteithResult:
    climate: ClimateSummary
    plant: PlantParams
    pot: PotParams
    pot_metrics: PotMetrics
    outputs: IrrigationOutputs
    assumptions: Assumptions


class ClimateComputationError(ValueError):
    """Raised when inputs are insufficient for ET calculations."""


def compute_penman_monteith(
    samples: Sequence[ClimateSample],
    plant: PlantParams,
    pot: PotParams,
    *,
    lookback_hours: float,
    assumed_wind_speed_m_s: float = 0.1,
    net_radiation_factor: float = 0.75,
) -> PenmanMonteithResult:
    if not samples:
        raise ClimateComputationError("At least one climate sample is required")

    temps = [sample.temperature_c for sample in samples if sample.temperature_c is not None]
    hums = [sample.humidity_pct for sample in samples if sample.humidity_pct is not None]
    if not temps or not hums:
        raise ClimateComputationError("Temperature and humidity data are required")

    avg_temp = _mean(temps)
    avg_humidity = max(0.0, min(100.0, _mean(hums)))

    pressures = [sample.pressure_hpa for sample in samples if sample.pressure_hpa is not None]
    avg_pressure_hpa = _mean(pressures) if pressures else 1013.25

    solar_values = [max(sample.solar_radiation_w_m2 or 0.0, 0.0) for sample in samples if sample.solar_radiation_w_m2 is not None]
    avg_solar = _mean(solar_values) if solar_values else 0.0

    wind_values = [max(sample.wind_speed_m_s or 0.0, 0.0) for sample in samples if sample.wind_speed_m_s is not None]
    wind_speed = _mean(wind_values) if wind_values else assumed_wind_speed_m_s
    wind_speed = max(wind_speed, 0.05)

    timestamps = sorted(sample.timestamp for sample in samples)
    coverage_hours = _calculate_coverage_hours(timestamps, lookback_hours)

    total_seconds = max(coverage_hours, 0.25) * 3600.0
    energy_mj_m2 = avg_solar * total_seconds / 1_000_000.0
    if coverage_hours <= 0.0:
        coverage_hours = lookback_hours
    net_radiation_mj_m2_day = energy_mj_m2 * net_radiation_factor
    if coverage_hours > 0:
        net_radiation_mj_m2_day *= 24.0 / coverage_hours

    pressure_kpa = avg_pressure_hpa * 0.1
    es = _saturation_vapor_pressure(avg_temp)
    ea = es * (avg_humidity / 100.0)
    delta = _delta_slope(avg_temp, es)
    gamma = 0.000665 * pressure_kpa

    numerator = 0.408 * delta * net_radiation_mj_m2_day
    vapor_deficit = max(es - ea, 0.0)
    numerator += gamma * (900.0 / (avg_temp + 273.0)) * wind_speed * vapor_deficit

    denominator = delta + gamma * (1.0 + 0.34 * wind_speed)
    if denominator <= 0.0:
        raise ClimateComputationError("Invalid psychrometric denominator")

    et0_mm_day = max(numerator / denominator, 0.0)
    etc_mm_day = max(et0_mm_day * max(plant.crop_coefficient, 0.0), 0.0)

    pot_metrics = _derive_pot_metrics(pot)
    daily_water_liters = etc_mm_day * pot_metrics.surface_area_m2

    irrigation_efficiency = max(pot.irrigation_efficiency, 0.1)
    adjusted_daily_liters = daily_water_liters / irrigation_efficiency
    adjusted_daily_liters = max(adjusted_daily_liters, 0.0)

    max_event = max(pot_metrics.max_event_liters, 0.0)
    if adjusted_daily_liters <= 0.0:
        events_per_day = 0.0
        ml_per_event = 0.0
    elif max_event > 0.0:
        events_per_day = max(1.0, adjusted_daily_liters / max_event)
        ml_per_event = (adjusted_daily_liters / events_per_day) * 1000.0
    else:
        events_per_day = 1.0
        ml_per_event = adjusted_daily_liters * 1000.0

    outputs = IrrigationOutputs(
        et0_mm_day=et0_mm_day,
        etc_mm_day=etc_mm_day,
        daily_water_liters=daily_water_liters,
        adjusted_daily_liters=adjusted_daily_liters,
        recommended_events_per_day=events_per_day,
        recommended_ml_per_event=ml_per_event,
        recommended_ml_per_day=adjusted_daily_liters * 1000.0,
    )

    climate = ClimateSummary(
        coverage_hours=coverage_hours,
        data_points=len(samples),
        avg_temperature_c=avg_temp,
        avg_humidity_pct=avg_humidity,
        avg_pressure_hpa=avg_pressure_hpa,
        avg_solar_w_m2=avg_solar,
        wind_speed_m_s=wind_speed,
        net_radiation_mj_m2_day=net_radiation_mj_m2_day,
    )

    assumptions = Assumptions(
        lookback_hours=lookback_hours,
        assumed_wind_speed_m_s=assumed_wind_speed_m_s,
        net_radiation_factor=net_radiation_factor,
    )

    return PenmanMonteithResult(
        climate=climate,
        plant=plant,
        pot=pot,
        pot_metrics=pot_metrics,
        outputs=outputs,
        assumptions=assumptions,
    )


def _mean(values: Iterable[float]) -> float:
    data = list(values)
    if not data:
        raise ClimateComputationError("Unable to compute mean of empty values")
    return math.fsum(data) / float(len(data))


def _calculate_coverage_hours(timestamps: Sequence[datetime], lookback_hours: float) -> float:
    if len(timestamps) < 2:
        return max(lookback_hours, 0.25)
    delta_seconds = (timestamps[-1] - timestamps[0]).total_seconds()
    if delta_seconds <= 0:
        return max(lookback_hours, 0.25)
    coverage_hours = delta_seconds / 3600.0
    if coverage_hours < 0.25:
        return max(lookback_hours, 0.25)
    return coverage_hours


def _saturation_vapor_pressure(temp_c: float) -> float:
    return 0.6108 * math.exp((17.27 * temp_c) / (temp_c + 237.3))


def _delta_slope(temp_c: float, es: float) -> float:
    return 4098.0 * es / ((temp_c + 237.3) ** 2)


def _derive_pot_metrics(pot: PotParams) -> PotMetrics:
    radius_m = (pot.diameter_cm / 100.0) / 2.0
    surface_area_m2 = math.pi * radius_m**2

    height_m = pot.height_cm / 100.0 if pot.height_cm > 0 else radius_m * 1.5
    height_m = max(height_m, 0.05)

    volume_m3 = surface_area_m2 * height_m
    volume_liters = volume_m3 * 1000.0

    available_fraction = min(max(pot.available_water_fraction, 0.0), 1.0)
    available_water_liters = volume_liters * available_fraction

    refill_fraction = min(max(pot.target_refill_fraction, 0.0), 1.0)
    max_event_liters = available_water_liters * refill_fraction

    return PotMetrics(
        surface_area_m2=surface_area_m2,
        volume_liters=volume_liters,
        available_water_liters=available_water_liters,
        max_event_liters=max_event_liters,
    )