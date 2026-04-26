"""Parameter learning helpers for ET controller coefficients."""

from __future__ import annotations

from math import isfinite, log
from typing import Tuple


def _clamp(value: float, bounds: tuple[float, float]) -> float:
    lower, upper = bounds
    if lower > upper:
        raise ValueError("Invalid bounds: lower greater than upper.")
    return max(lower, min(upper, value))


def update_Kcb_struct(
    Kcb_struct: float,
    Kcb_hat: float,
    alpha: float,
    bounds: tuple[float, float],
) -> float:
    """Return updated structural Kcb, blended toward ``Kcb_hat``."""

    if not isfinite(Kcb_hat):
        return _clamp(Kcb_struct, bounds)
    if alpha <= 0.0:
        return _clamp(Kcb_struct, bounds)
    target = _clamp(Kcb_hat, bounds)
    updated = (1.0 - alpha) * Kcb_struct + alpha * target
    return _clamp(updated, bounds)


def update_c_aero(
    c_aero: float,
    Kcb_eff_hat: float,
    Kcb_struct: float,
    beta: float,
    bounds: tuple[float, float] = (-0.5, 0.8),
) -> float:
    """Return updated aerodynamic coefficient informed by ``Kcb_eff_hat``."""

    if beta <= 0.0 or not isfinite(Kcb_eff_hat):
        return _clamp(c_aero, bounds)

    desired = Kcb_eff_hat - Kcb_struct
    updated = c_aero + beta * (desired - c_aero)
    return _clamp(updated, bounds)


def update_tau_e(
    tau_e_h: float,
    Ke_obs: float,
    Ke_prev: float,
    dt_h: float,
    beta: float,
    bounds: tuple[float, float] = (3.0, 72.0),
) -> Tuple[float, float]:
    """Return updated evaporation time constant and the stored ``Ke_prev``."""

    tau_clamped = _clamp(tau_e_h, bounds)
    if beta <= 0.0 or dt_h <= 0.0:
        return tau_clamped, max(Ke_obs, 0.0)

    if Ke_obs <= 0.0 or Ke_prev <= 0.0 or Ke_obs >= Ke_prev:
        return tau_clamped, max(Ke_obs, 0.0)

    ratio = Ke_obs / Ke_prev
    if ratio <= 0.0:
        return tau_clamped, max(Ke_obs, 0.0)

    try:
        tau_hat = -dt_h / log(ratio)
    except (ValueError, ZeroDivisionError):
        return tau_clamped, max(Ke_obs, 0.0)

    if not isfinite(tau_hat) or tau_hat <= 0.0:
        return tau_clamped, max(Ke_obs, 0.0)

    updated_tau = (1.0 - beta) * tau_clamped + beta * tau_hat
    updated_tau = _clamp(updated_tau, bounds)
    return updated_tau, max(Ke_obs, 0.0)
