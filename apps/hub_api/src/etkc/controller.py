"""Controller logic for ET-based irrigation of container plants."""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Dict, Tuple

from pydantic import BaseModel

from .coeffs import (
    Ke_exp,
    Ke_rew,
    Kcmax,
    Ks_from_depletion,
    Ks_from_theta,
    TAW_mm,
)
from .learner import update_Kcb_struct, update_c_aero, update_tau_e
from .observe import observed_ET_mm, observed_ET_mm_from_theta
from .reference import fao56_pm_hourly
from .state import PotState, PotStatic, StepConfig, StepSensors

EPSILON: float = 1.0e-6


class StepContext(BaseModel):
    """Snapshot of the inputs that produced a step result."""

    sensors: StepSensors
    dt_h: float
    pot_area_m2: float


class StepResult(BaseModel):
    ET0_mm: float
    ETc_model_mm: float
    ETc_obs_mm: float | None
    Kcb_struct: float
    Kcb_eff: float
    c_aero: float
    Ke: float
    Ks: float
    De_mm: float
    Dr_mm: float
    REW_mm: float
    tau_e_h: float
    need_irrigation: bool
    recommend_mm: float
    context: StepContext
    metadata: Dict[str, Any] | None = None


def mm_to_mL(depth_mm: float, area_m2: float) -> float:
    """Convert depth [mm] over an area [m^2] to millilitres."""

    if area_m2 <= 0.0 or depth_mm <= 0.0:
        return 0.0
    return depth_mm * area_m2 * 1000.0


def _mL_to_mm(volume_mL: float, area_m2: float) -> float:
    if area_m2 <= 0.0 or volume_mL <= 0.0:
        return 0.0
    return volume_mL / (area_m2 * 1000.0)


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _theta_from_depletion(static: PotStatic, Dr_mm: float) -> float | None:
    if static.depth_m <= 0.0:
        return None
    theta = static.theta_fc - (Dr_mm / 1000.0) / static.depth_m
    return _clamp(theta, static.theta_wp, static.theta_fc)


def step(
    static: PotStatic,
    state: PotState,
    sensors: StepSensors,
    cfg: StepConfig,
) -> Tuple[PotState, StepResult]:
    """
    Execute one ET-based control step.

    Returns:
        Updated state and summary result for the step.
    """

    if cfg.dt_h <= 0.0:
        raise ValueError("cfg.dt_h must be positive.")

    area = static.pot_area_m2
    u2 = sensors.u2_ms if sensors.u2_ms is not None else cfg.u2_default_ms
    et0_rate_mmph = fao56_pm_hourly(
        T_C=sensors.T_C,
        RH_pct=sensors.RH_pct,
        Rs_MJ_m2_h=sensors.Rs_MJ_m2_h,
        u2_ms=u2,
    )
    ET0_mm = max(0.0, et0_rate_mmph * cfg.dt_h)

    taw_mm = TAW_mm(static.theta_fc, static.theta_wp, static.depth_m)
    Ks = Ks_from_theta(sensors.theta, static.theta_fc, static.theta_wp) if sensors.theta is not None else Ks_from_depletion(state.Dr_mm, taw_mm, cfg.p_RAW)
    Ks = _clamp(Ks, 0.0, 1.0)

    ac_term = state.c_AC if sensors.AC_on else 0.0
    kc_max = Kcmax(u2_ms=u2, RHmin_pct=sensors.RH_pct, base=cfg.Kcmax_base)
    Kcb_eff_model = state.Kcb_struct * (1.0 + state.c_aero + ac_term)
    Kcb_eff_model = _clamp(Kcb_eff_model, 0.0, kc_max)

    inflow_mm = _mL_to_mm(sensors.inflow_mL, area)
    drain_mm = _mL_to_mm(sensors.drain_mL, area)
    net_inflow_mm = inflow_mm - drain_mm
    surface_recharge_mm = max(net_inflow_mm, 0.0)

    De_pre = max(state.De_mm - surface_recharge_mm, 0.0)
    Ke = 0.0
    De_post = De_pre
    tau_e_h = state.tau_e_h
    Ke_prev = state.Ke_prev

    if cfg.Ke_mode.lower() == "exp":
        ke_cap = max(kc_max - Kcb_eff_model, 0.0)
        if sensors.inflow_mL > 0.0:
            Ke = ke_cap
        else:
            Ke = Ke_exp(
                t_since_wet_h=cfg.dt_h,
                Kcb_eff=Kcb_eff_model,
                tau_e_h=state.tau_e_h,
                u2_ms=u2,
                RHmin_pct=sensors.RH_pct,
            )
        Ke = _clamp(Ke, 0.0, ke_cap)
        Ke_obs = Ke
        tau_e_h, Ke_prev = update_tau_e(
            tau_e_h=state.tau_e_h,
            Ke_obs=Ke_obs,
            Ke_prev=state.Ke_prev,
            dt_h=cfg.dt_h,
            beta=cfg.beta_c_aero,
        )
    else:
        Ke, De_post = Ke_rew(
            ET0_mm=ET0_mm,
            Kcb_eff=Kcb_eff_model,
            De_mm=De_pre,
            REW_mm=state.REW_mm,
            u2_ms=u2,
            RHmin_pct=sensors.RH_pct,
        )
        Ke_prev = Ke

    ETc_model_mm = max(0.0, ET0_mm * ((Kcb_eff_model * Ks) + Ke))

    et_obs_balance = observed_ET_mm(
        inflow_mL=sensors.inflow_mL,
        drain_mL=sensors.drain_mL,
        dStorage_mL=sensors.dStorage_mL,
        pot_area_m2=area,
    )
    theta_prev = _theta_from_depletion(static, state.Dr_mm)
    et_obs_theta = observed_ET_mm_from_theta(
        theta_now=sensors.theta,
        theta_prev=theta_prev,
        depth_m=static.depth_m,
    )
    ETc_obs_mm = None
    if et_obs_balance is not None:
        ETc_obs_mm = max(0.0, et_obs_balance)
    elif et_obs_theta is not None:
        ETc_obs_mm = max(0.0, et_obs_theta)

    can_learn = (
        ETc_obs_mm is not None
        and Ke < cfg.learn_when_Ke_lt
        and Ks > cfg.learn_when_Ks_gt
        and et0_rate_mmph > cfg.ET0_min_learn_mmph
        and ET0_mm > 0.0
    )

    new_Kcb_struct = state.Kcb_struct
    new_c_aero = state.c_aero

    if can_learn:
        Kc_obs = ETc_obs_mm / max(ET0_mm, EPSILON)
        Kcb_eff_times_Ks = max(0.0, Kc_obs - Ke)
        if Ks > EPSILON:
            Kcb_eff_hat = Kcb_eff_times_Ks / Ks
        else:
            Kcb_eff_hat = Kcb_eff_model
        denom = 1.0 + state.c_aero + ac_term
        if denom > EPSILON:
            Kcb_struct_hat = Kcb_eff_hat / denom
        else:
            Kcb_struct_hat = state.Kcb_struct

        new_Kcb_struct = update_Kcb_struct(
            Kcb_struct=state.Kcb_struct,
            Kcb_hat=Kcb_struct_hat,
            alpha=cfg.alpha_Kcb,
            bounds=cfg.Kcb_bounds,
        )
        new_c_aero = update_c_aero(
            c_aero=state.c_aero,
            Kcb_eff_hat=Kcb_eff_hat,
            Kcb_struct=new_Kcb_struct,
            beta=cfg.beta_c_aero,
        )

        if cfg.Ke_mode.lower() == "exp":
            Ke_obs = max(0.0, Kc_obs - Kcb_eff_times_Ks)
            tau_e_h, Ke_prev = update_tau_e(
                tau_e_h=tau_e_h,
                Ke_obs=Ke_obs,
                Ke_prev=Ke_prev,
                dt_h=cfg.dt_h,
                beta=cfg.beta_c_aero,
            )

    Dr_next = state.Dr_mm + ETc_model_mm - net_inflow_mm
    Dr_next = _clamp(Dr_next, 0.0, taw_mm)

    allowable_mm = cfg.allowable_depletion_frac * taw_mm
    need_irrigation = Dr_next >= allowable_mm
    recommend_mm = max(0.0, Dr_next - allowable_mm)

    last_irrigation_ts = (
        0.0
        if sensors.inflow_mL > 0.0
        else (
            (state.last_irrigation_ts or 0.0) + cfg.dt_h
            if state.last_irrigation_ts is not None
            else None
        )
    )

    new_state = replace(
        state,
        Kcb_struct=new_Kcb_struct,
        c_aero=new_c_aero,
        De_mm=De_post,
        Dr_mm=Dr_next,
        tau_e_h=tau_e_h,
        Ke_prev=Ke_prev,
        last_irrigation_ts=last_irrigation_ts,
    )

    Kcb_eff_updated = new_Kcb_struct * (1.0 + new_c_aero + ac_term)
    Kcb_eff_updated = _clamp(Kcb_eff_updated, 0.0, kc_max)

    context = StepContext(
        sensors=sensors,
        dt_h=cfg.dt_h,
        pot_area_m2=static.pot_area_m2,
    )

    result = StepResult(
        ET0_mm=ET0_mm,
        ETc_model_mm=ETc_model_mm,
        ETc_obs_mm=ETc_obs_mm,
        Kcb_struct=new_Kcb_struct,
        Kcb_eff=Kcb_eff_updated,
        c_aero=new_c_aero,
        Ke=Ke,
        Ks=Ks,
        De_mm=De_post,
        Dr_mm=Dr_next,
        REW_mm=new_state.REW_mm,
        tau_e_h=tau_e_h,
        need_irrigation=need_irrigation,
        recommend_mm=recommend_mm,
        context=context,
    )

    return new_state, result
