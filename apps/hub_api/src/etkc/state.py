"""State and configuration models for container ET control (SI units)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from pydantic import BaseModel


@dataclass
class PotStatic:
    """Static pot parameters (SI units).

    Attributes:
        pot_area_m2: Opening surface area of the container [m^2].
        depth_m: Effective rooting depth used for storage calculations [m].
        theta_fc: Volumetric water content at field capacity [m^3 m^-3].
        theta_wp: Volumetric water content at wilting point [m^3 m^-3].
        class_name: Taxonomic or horticultural class identifier [-].
    """

    pot_area_m2: float
    depth_m: float
    theta_fc: float
    theta_wp: float
    class_name: str = "woody"


@dataclass
class PotState:
    """Dynamic plant state tracked by the controller (SI units).

    Attributes:
        Kcb_struct: Structural basal crop coefficient [-].
        c_aero: Aerodynamic enhancement term [-].
        c_AC: Indoor air conditioning coefficient (for VPD adjustments) [-].
        De_mm: Surface layer depletion [mm].
        Dr_mm: Root-zone depletion relative to field capacity [mm].
        REW_mm: Readily evaporable water threshold [mm].
        tau_e_h: Evaporation e-folding time constant [h].
        Ke_prev: Previous soil evaporation coefficient [-].
        last_irrigation_ts: Timestamp of last irrigation event [s since epoch].
    """

    Kcb_struct: float = 0.6
    c_aero: float = 0.0
    c_AC: float = 0.0
    De_mm: float = 0.0
    Dr_mm: float = 0.0
    REW_mm: float = 5.0
    tau_e_h: float = 12.0
    Ke_prev: float = 0.0
    last_irrigation_ts: float | None = None


class StepSensors(BaseModel):
    """Sensor inputs collected over a control interval."""

    T_C: float
    RH_pct: float
    Rs_MJ_m2_h: float
    u2_ms: float | None = None
    theta: float | None = None
    inflow_mL: float = 0.0
    drain_mL: float = 0.0
    dStorage_mL: float | None = None
    AC_on: bool = False


class StepConfig(BaseModel):
    """Controller configuration for a single step."""

    dt_h: float = 1.0
    u2_default_ms: float = 0.25
    Kcb_bounds: tuple[float, float] = (0.05, 1.5)
    alpha_Kcb: float = 0.1
    beta_c_aero: float = 0.1
    Ke_mode: str = "rew"  # or "exp"
    Kcmax_base: float = 1.05
    learn_when_Ke_lt: float = 0.05
    learn_when_Ks_gt: float = 0.95
    ET0_min_learn_mmph: float = 0.05
    p_RAW: float = 0.5
    allowable_depletion_frac: float = 0.5
    auto_mode: bool = False
    max_auto_irrigation_mm: float = 5.0


_STATE_PRESETS: Final[dict[str, dict[str, float]]] = {
    "succulent": {
        "Kcb_struct": 0.35,
        "c_aero": 0.0,
        "c_AC": 0.0,
        "REW_mm": 2.5,
        "tau_e_h": 24.0,
    },
    "herb": {
        "Kcb_struct": 0.8,
        "c_aero": 0.05,
        "c_AC": 0.0,
        "REW_mm": 4.5,
        "tau_e_h": 10.0,
    },
    "woody": {
        "Kcb_struct": 0.6,
        "c_aero": 0.02,
        "c_AC": 0.0,
        "REW_mm": 5.0,
        "tau_e_h": 12.0,
    },
    "tropical": {
        "Kcb_struct": 1.0,
        "c_aero": 0.1,
        "c_AC": 0.05,
        "REW_mm": 6.0,
        "tau_e_h": 8.0,
    },
}


def default_state_for(class_name: str) -> PotState:
    """Return a PotState preset for the given class name."""

    preset_key = class_name.lower()
    params = _STATE_PRESETS.get(preset_key, _STATE_PRESETS["woody"])
    return PotState(**params)


__all__ = [
    "PotStatic",
    "PotState",
    "StepSensors",
    "StepConfig",
    "default_state_for",
]
