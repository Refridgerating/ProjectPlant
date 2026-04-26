"""Crop and substrate coefficient utilities for container evapotranspiration."""

from dataclasses import dataclass
from math import exp
from typing import Final, Optional

MIN_FRACTION: Final[float] = 1.0e-6


@dataclass(frozen=True)
class EvaporationCoefficients:
    """Computed soil evaporation modifiers.

    Attributes:
        ke: Soil evaporation coefficient (dimensionless).
        kr: Reduction coefficient for the evaporation layer (dimensionless).
        stage: Either ``"rew"`` when readily evaporable water is available
            or ``"depletion"`` when the evaporation layer is drying.
    """

    ke: float
    kr: float
    stage: str


def kcb_struct(
    canopy_fraction: float,
    container_coefficient: float,
    min_kcb: float,
    max_kcb: float,
) -> float:
    """Return the structural basal crop coefficient ``Kcb`` (dimensionless).

    Args:
        canopy_fraction: Fraction of container surface covered by foliage [0-1].
        container_coefficient: Learned container coefficient scaling [-].
        min_kcb: Lower bound for the basal crop coefficient [-].
        max_kcb: Upper bound for the basal crop coefficient [-].

    Returns:
        Basal crop coefficient adjusted for canopy cover and container effects [-].
    """

    canopy = min(max(canopy_fraction, 0.0), 1.0)
    base = min_kcb + (max_kcb - min_kcb) * canopy ** 0.5
    adjusted = base * max(container_coefficient, 0.0)
    return max(min_kcb, min(max_kcb, adjusted))


def c_aero(
    wind_speed_m_s: float,
    crop_height_m: float,
    relative_humidity: Optional[float] = None,
) -> float:
    """Return the aerodynamic enhancement term for ``Kc_max`` (dimensionless).

    Args:
        wind_speed_m_s: Wind speed at 2 m height [m s^-1].
        crop_height_m: Mean canopy height [m].
        relative_humidity: Optional minimum relative humidity as a fraction [0-1].

    Returns:
        Aerodynamic contribution to ``Kc_max`` (non-negative, dimensionless).
    """

    rh_fraction = 0.45 if relative_humidity is None else min(max(relative_humidity, 0.0), 1.0)
    rh_percent = rh_fraction * 100.0
    height_term = (crop_height_m / 0.5) ** 0.3 if crop_height_m > 0.0 else 0.0
    aero = 0.04 * max(wind_speed_m_s - 1.0, 0.0) - 0.004 * (rh_percent - 45.0)
    aero = max(0.0, aero) * max(height_term, 0.0)
    return max(0.0, aero)


def evaporation_coefficient(
    tew_mm: float,
    rew_mm: float,
    surface_depletion_mm: float,
    few: float,
    kc_max: float,
    kcb: float,
) -> EvaporationCoefficients:
    """Return the soil evaporation coefficient ``Ke`` (dimensionless).

    Args:
        tew_mm: Total evaporable water in the surface layer [mm].
        rew_mm: Readily evaporable water [mm].
        surface_depletion_mm: Current depletion of the surface layer [mm].
        few: Fraction of soil surface that is both wet and exposed [0-1].
        kc_max: Maximum crop coefficient for the current step [-].
        kcb: Basal crop coefficient [-].

    Returns:
        EvaporationCoefficients with ``ke`` (dimensionless) and metadata.
    """

    if few <= MIN_FRACTION or kc_max <= kcb:
        return EvaporationCoefficients(ke=0.0, kr=0.0, stage="dry")

    tew = max(tew_mm, 0.0)
    rew = min(max(rew_mm, 0.0), tew)
    depletion = min(max(surface_depletion_mm, 0.0), tew)

    if depletion <= rew:
        kr = 1.0
        stage = "rew"
    else:
        denominator = max(tew - rew, MIN_FRACTION)
        kr = max(0.0, min(1.0, (tew - depletion) / denominator))
        stage = "depletion"

    ke = max(0.0, min(kr * (kc_max - kcb), few * kc_max))
    return EvaporationCoefficients(ke=ke, kr=kr, stage=stage)


def stress_coefficient(
    depletion_rootzone_mm: float,
    taw_mm: float,
    raw_mm: float,
    min_ks: float = 0.0,
) -> float:
    """Return the root-zone water stress coefficient ``Ks`` (dimensionless).

    Args:
        depletion_rootzone_mm: Current root-zone depletion [mm].
        taw_mm: Total available water for the root zone [mm].
        raw_mm: Readily available water threshold [mm].
        min_ks: Minimum allowable stress coefficient [-].

    Returns:
        Ks constrained to the range ``[min_ks, 1]`` (dimensionless).
    """

    taw = max(taw_mm, MIN_FRACTION)
    raw = min(max(raw_mm, 0.0), taw)
    depletion = max(depletion_rootzone_mm, 0.0)

    if depletion <= raw:
        return 1.0

    ks = (taw - depletion) / max(taw - raw, MIN_FRACTION)
    return max(min_ks, min(1.0, ks))


def TAW_mm(theta_fc: float, theta_wp: float, depth_m: float) -> float:
    """Return total available water in the root zone [mm]."""

    if depth_m <= 0.0:
        return 0.0
    available = max(theta_fc - theta_wp, 0.0)
    return available * depth_m * 1000.0


def Ks_from_theta(theta: float, theta_fc: float, theta_wp: float) -> float:
    """Return water stress coefficient using measured water content [dimensionless]."""

    if theta <= theta_wp:
        return 0.0
    if theta >= theta_fc:
        return 1.0
    return (theta - theta_wp) / max(theta_fc - theta_wp, MIN_FRACTION)


def Ks_from_depletion(Dr_mm: float, TAW_mm_value: float, p_raw: float) -> float:
    """Return stress coefficient from depletion (dimensionless)."""

    taw = max(TAW_mm_value, MIN_FRACTION)
    raw = max(min(p_raw * taw, taw), 0.0)
    depletion = max(Dr_mm, 0.0)
    if depletion <= raw:
        return 1.0
    ks = (taw - depletion) / max(taw - raw, MIN_FRACTION)
    return max(0.0, min(1.0, ks))


def choose_Ks(
    theta: float | None,
    Dr_mm: float,
    TAW_mm_value: float,
    p_raw: float,
    theta_fc: float | None = None,
    theta_wp: float | None = None,
) -> float:
    """Choose stress coefficient based on theta when available."""

    if theta is not None and theta_fc is not None and theta_wp is not None:
        return Ks_from_theta(theta, theta_fc, theta_wp)
    return Ks_from_depletion(Dr_mm, TAW_mm_value, p_raw)


def Kcmax(u2_ms: float, RHmin_pct: float | None = None, base: float = 1.05) -> float:
    """Return maximum crop coefficient ``Kcmax`` (dimensionless)."""

    u2 = max(u2_ms, 0.0)
    rh_min = 60.0 if RHmin_pct is None else max(0.0, min(100.0, RHmin_pct))
    adjustment = 0.04 * (u2 - 0.3) - 0.004 * (rh_min - 45.0)
    adjustment = max(adjustment, 0.0)
    kc_max = max(base, base + adjustment)
    return max(kc_max, 0.0)


def Ke_rew(
    ET0_mm: float,
    Kcb_eff: float,
    De_mm: float,
    REW_mm: float,
    u2_ms: float,
    RHmin_pct: float | None,
) -> tuple[float, float]:
    """Return ``(Ke, updated_De_mm)`` using the REW method."""

    rew = max(REW_mm, MIN_FRACTION)
    depletion = min(max(De_mm, 0.0), rew)
    kr = max(0.0, min(1.0, 1.0 - depletion / rew))

    kc_max = Kcmax(u2_ms=u2_ms, RHmin_pct=RHmin_pct)
    ke_cap = max(kc_max - Kcb_eff, 0.0)
    ke = max(0.0, min(ke_cap, kr * ke_cap))

    et_evap = max(ET0_mm, 0.0) * ke
    updated_depletion = min(rew, max(0.0, depletion + et_evap))
    return ke, updated_depletion


def Ke_exp(
    t_since_wet_h: float,
    Kcb_eff: float,
    tau_e_h: float,
    u2_ms: float,
    RHmin_pct: float | None,
) -> float:
    """Return exponential-decay soil evaporation coefficient."""

    kc_max = Kcmax(u2_ms=u2_ms, RHmin_pct=RHmin_pct)
    ke_cap = max(kc_max - Kcb_eff, 0.0)
    if tau_e_h <= 0.0:
        return ke_cap

    t_hours = max(t_since_wet_h, 0.0)
    decay = exp(-t_hours / max(tau_e_h, MIN_FRACTION))
    ke = ke_cap * decay
    return max(0.0, min(ke, ke_cap))
