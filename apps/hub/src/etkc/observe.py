"""Observed evapotranspiration diagnostics for the ETc-Kc controller."""

from __future__ import annotations


def observed_ET_mm(
    inflow_mL: float | None,
    drain_mL: float | None,
    dStorage_mL: float | None,
    pot_area_m2: float,
) -> float | None:
    """Return observed evapotranspiration depth from volume fluxes [mm].

    ETc_obs = (inflow - drainage - delta_storage) / (area * 1000).
    Returns ``None`` when any required term is unavailable.
    """

    if pot_area_m2 <= 0.0:
        return None
    if dStorage_mL is None or inflow_mL is None or drain_mL is None:
        return None

    depth_mm = (inflow_mL - drain_mL - dStorage_mL) / (pot_area_m2 * 1000.0)
    return depth_mm


def observed_ET_mm_from_theta(
    theta_now: float | None,
    theta_prev: float | None,
    depth_m: float,
) -> float | None:
    """Approximate observed evapotranspiration from volumetric water content change [mm]."""

    if theta_now is None or theta_prev is None or depth_m <= 0.0:
        return None
    delta_theta = theta_prev - theta_now
    return delta_theta * depth_m * 1000.0
