from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from services.evapotranspiration import (
    Assumptions,
    ClimateComputationError,
    ClimateSample,
    ClimateSummary,
    IrrigationOutputs,
    PenmanMonteithResult,
    PlantParams,
    PotMetrics,
    PotParams,
    compute_penman_monteith,
)

router = APIRouter(prefix="/irrigation", tags=["irrigation"])


class ClimateSampleModel(BaseModel):
    timestamp: datetime
    temperature_c: float | None = Field(default=None, description="Ambient temperature in deg C")
    humidity_pct: float | None = Field(default=None, description="Relative humidity in percent")
    pressure_hpa: float | None = Field(default=None, description="Barometric pressure in hPa")
    solar_radiation_w_m2: float | None = Field(default=None, description="Solar radiation in W/m^2")
    wind_speed_m_s: float | None = Field(default=None, description="Wind speed in m/s measured near canopy")


class PlantProfileModel(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    crop_coefficient: float = Field(default=0.85, ge=0.1, le=2.0)


class PotProfileModel(BaseModel):
    diameter_cm: float = Field(..., gt=5.0, le=120.0)
    height_cm: float = Field(default=24.0, gt=5.0, le=120.0)
    available_water_fraction: float = Field(default=0.35, ge=0.05, le=0.9)
    irrigation_efficiency: float = Field(default=0.9, ge=0.1, le=1.0)
    target_refill_fraction: float = Field(default=0.4, ge=0.1, le=1.0)


class IrrigationRequest(BaseModel):
    method: Literal["penman_monteith"] = "penman_monteith"
    lookback_hours: float = Field(default=24.0, ge=0.25, le=168.0)
    assumed_wind_speed_m_s: float = Field(default=0.1, ge=0.0, le=3.0)
    net_radiation_factor: float = Field(default=0.75, ge=0.1, le=1.2)
    samples: list[ClimateSampleModel]
    plant: PlantProfileModel = Field(default_factory=PlantProfileModel)
    pot: PotProfileModel

    @field_validator("samples")
    @classmethod
    def ensure_samples(cls, value: list[ClimateSampleModel]) -> list[ClimateSampleModel]:
        if not value:
            raise ValueError("At least one climate sample is required")
        return value


class ClimateSummaryModel(BaseModel):
    coverage_hours: float
    data_points: int
    avg_temperature_c: float
    avg_humidity_pct: float
    avg_pressure_hpa: float
    avg_solar_w_m2: float
    wind_speed_m_s: float
    net_radiation_mj_m2_day: float


class PotMetricsModel(BaseModel):
    surface_area_m2: float
    volume_liters: float
    available_water_liters: float
    max_event_liters: float


class IrrigationOutputsModel(BaseModel):
    et0_mm_day: float
    etc_mm_day: float
    daily_water_liters: float
    adjusted_daily_liters: float
    recommended_events_per_day: float
    recommended_ml_per_event: float
    recommended_ml_per_day: float


class AssumptionsModel(BaseModel):
    lookback_hours: float
    assumed_wind_speed_m_s: float
    net_radiation_factor: float


class DiagnosticsModel(BaseModel):
    notes: list[str] = Field(default_factory=list)


class IrrigationResponse(BaseModel):
    method: str
    climate: ClimateSummaryModel
    plant: PlantProfileModel
    pot: PotProfileModel
    pot_metrics: PotMetricsModel
    outputs: IrrigationOutputsModel
    assumptions: AssumptionsModel
    diagnostics: DiagnosticsModel


@router.post("/estimate", response_model=IrrigationResponse)
async def estimate_irrigation(payload: IrrigationRequest) -> IrrigationResponse:
    try:
        result = compute_penman_monteith(
            samples=[_to_sample(sample) for sample in payload.samples],
            plant=PlantParams(crop_coefficient=payload.plant.crop_coefficient, name=payload.plant.name),
            pot=PotParams(
                diameter_cm=payload.pot.diameter_cm,
                height_cm=payload.pot.height_cm,
                available_water_fraction=payload.pot.available_water_fraction,
                irrigation_efficiency=payload.pot.irrigation_efficiency,
                target_refill_fraction=payload.pot.target_refill_fraction,
            ),
            lookback_hours=payload.lookback_hours,
            assumed_wind_speed_m_s=payload.assumed_wind_speed_m_s,
            net_radiation_factor=payload.net_radiation_factor,
        )
    except ClimateComputationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    diagnostics = _build_diagnostics(payload, result)

    return IrrigationResponse(
        method=payload.method,
        climate=_to_climate_model(result.climate),
        plant=payload.plant,
        pot=payload.pot,
        pot_metrics=_to_pot_metrics_model(result.pot_metrics),
        outputs=_to_outputs_model(result.outputs),
        assumptions=_to_assumptions_model(result.assumptions),
        diagnostics=diagnostics,
    )


def _to_sample(sample: ClimateSampleModel) -> ClimateSample:
    return ClimateSample(
        timestamp=sample.timestamp,
        temperature_c=sample.temperature_c,
        humidity_pct=sample.humidity_pct,
        pressure_hpa=sample.pressure_hpa,
        solar_radiation_w_m2=sample.solar_radiation_w_m2,
        wind_speed_m_s=sample.wind_speed_m_s,
    )


def _to_climate_model(summary: ClimateSummary) -> ClimateSummaryModel:
    return ClimateSummaryModel(
        coverage_hours=summary.coverage_hours,
        data_points=summary.data_points,
        avg_temperature_c=summary.avg_temperature_c,
        avg_humidity_pct=summary.avg_humidity_pct,
        avg_pressure_hpa=summary.avg_pressure_hpa,
        avg_solar_w_m2=summary.avg_solar_w_m2,
        wind_speed_m_s=summary.wind_speed_m_s,
        net_radiation_mj_m2_day=summary.net_radiation_mj_m2_day,
    )


def _to_pot_metrics_model(metrics: PotMetrics) -> PotMetricsModel:
    return PotMetricsModel(
        surface_area_m2=metrics.surface_area_m2,
        volume_liters=metrics.volume_liters,
        available_water_liters=metrics.available_water_liters,
        max_event_liters=metrics.max_event_liters,
    )


def _to_outputs_model(outputs: IrrigationOutputs | PenmanMonteithResult) -> IrrigationOutputsModel:
    if isinstance(outputs, PenmanMonteithResult):
        outputs = outputs.outputs
    return IrrigationOutputsModel(
        et0_mm_day=outputs.et0_mm_day,
        etc_mm_day=outputs.etc_mm_day,
        daily_water_liters=outputs.daily_water_liters,
        adjusted_daily_liters=outputs.adjusted_daily_liters,
        recommended_events_per_day=outputs.recommended_events_per_day,
        recommended_ml_per_event=outputs.recommended_ml_per_event,
        recommended_ml_per_day=outputs.recommended_ml_per_day,
    )


def _to_assumptions_model(assumptions: Assumptions) -> AssumptionsModel:
    return AssumptionsModel(
        lookback_hours=assumptions.lookback_hours,
        assumed_wind_speed_m_s=assumptions.assumed_wind_speed_m_s,
        net_radiation_factor=assumptions.net_radiation_factor,
    )


def _build_diagnostics(payload: IrrigationRequest, result: PenmanMonteithResult) -> DiagnosticsModel:
    notes: list[str] = []
    if not any(sample.solar_radiation_w_m2 is not None for sample in payload.samples):
        notes.append("Solar radiation missing; net radiation scaled from configured factor.")
    if not any(sample.wind_speed_m_s is not None for sample in payload.samples):
        notes.append(
            f"Wind speed unavailable; assumed {payload.assumed_wind_speed_m_s:.2f} m/s for Penman-Monteith denominator."
        )
    if result.outputs.daily_water_liters <= 0:
        notes.append("Computed evapotranspiration is negligible; irrigation not required for the selected window.")
    if result.pot_metrics.max_event_liters <= 0:
        notes.append("Pot available water storage is zero or negative; check substrate parameters.")
    return DiagnosticsModel(notes=notes)