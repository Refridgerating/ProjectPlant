"""Simulation utilities for the ETc controller."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace
from math import pi, sin
from typing import List, Tuple

from .coeffs import Ks_from_depletion, Ke_rew, TAW_mm
from .controller import StepResult, mm_to_mL, step
from .reference import fao56_pm_hourly
from .state import PotState, PotStatic, StepConfig, StepSensors


class Simulator:
    """Iterative simulator for container evapotranspiration control.

    Args:
        static: Pot configuration used for all timesteps.
        initial_state: Initial state at the beginning of the simulation horizon.
    """

    def __init__(self, static: PotStatic, initial_state: PotState) -> None:
        self._static = static
        self._state = initial_state

    @property
    def state(self) -> PotState:
        """Return the latest simulated state [-]."""

        return self._state

    def step(self, sensors: StepSensors, config: StepConfig) -> StepResult:
        """Advance the simulator by one control step."""

        new_state, result = step(self._static, self._state, sensors, config)
        self._state = new_state
        return result

    def run(
        self,
        sequence: Iterable[Tuple[StepSensors, StepConfig]],
    ) -> List[StepResult]:
        """Run the simulator across a sequence of sensor/config pairs."""

        return [self.step(sensors, cfg) for sensors, cfg in sequence]


def _hourly_radiation(hour: int) -> float:
    """Return deterministic hourly shortwave radiation [MJ m^-2 h^-1]."""

    hour_of_day = hour % 24
    solar = sin(pi * hour_of_day / 12.0)
    return max(0.0, 1.8 * solar)


def _hourly_temperature(hour: int) -> float:
    """Return deterministic hourly air temperature [degC]."""

    return 24.0 + 6.0 * sin((2.0 * pi * (hour - 7)) / 24.0)


def _hourly_relative_humidity(hour: int) -> float:
    """Return deterministic hourly relative humidity [%]."""

    return 60.0 - 15.0 * sin((2.0 * pi * (hour - 10)) / 24.0)


def run_deterministic_demo(hours: int = 48) -> float:
    """Run a deterministic 2-day scenario and print the daily ET MAE [mm]."""

    static = PotStatic(
        pot_area_m2=0.0314,
        depth_m=0.25,
        theta_fc=0.32,
        theta_wp=0.12,
        class_name="herb",
    )
    initial_state = PotState(
        Kcb_struct=0.75,
        c_aero=0.05,
        c_AC=0.0,
        De_mm=1.5,
        Dr_mm=2.0,
        REW_mm=4.5,
        tau_e_h=12.0,
        Ke_prev=0.4,
    )

    simulator = Simulator(static, initial_state)
    truth_state = replace(initial_state)
    cfg = StepConfig()

    taw_mm = TAW_mm(static.theta_fc, static.theta_wp, static.depth_m)
    daily_model: List[float] = [0.0, 0.0]
    daily_observed: List[float] = [0.0, 0.0]
    u2_ms = 0.3

    for hour in range(hours):
        day_index = min(len(daily_model) - 1, hour // 24)
        Rs = _hourly_radiation(hour)
        T_C = _hourly_temperature(hour)
        RH_pct = _hourly_relative_humidity(hour)

        irrigation_mm = 6.0 if hour in {6, 32} else 0.0
        inflow_mL = mm_to_mL(irrigation_mm, static.pot_area_m2)
        drain_mL = 0.0
        net_inflow_mm = irrigation_mm
        surface_recharge_mm = max(net_inflow_mm, 0.0)

        De_pre_true = max(truth_state.De_mm - surface_recharge_mm, 0.0)

        et0_rate_mmph = fao56_pm_hourly(
            T_C=T_C,
            RH_pct=RH_pct,
            Rs_MJ_m2_h=Rs,
            u2_ms=u2_ms,
        )
        ET0_mm = et0_rate_mmph * cfg.dt_h

        Ks_true = Ks_from_depletion(truth_state.Dr_mm, taw_mm, cfg.p_RAW)
        Kcb_eff_true = truth_state.Kcb_struct * (1.0 + truth_state.c_aero)
        Ke_true, De_post_true = Ke_rew(
            ET0_mm=ET0_mm,
            Kcb_eff=Kcb_eff_true,
            De_mm=De_pre_true,
            REW_mm=truth_state.REW_mm,
            u2_ms=u2_ms,
            RHmin_pct=RH_pct,
        )

        ETc_true = ET0_mm * ((Kcb_eff_true * Ks_true) + Ke_true)
        Dr_next_true = truth_state.Dr_mm + ETc_true - net_inflow_mm
        Dr_next_true = max(0.0, min(taw_mm, Dr_next_true))

        noise = 0.05 * sin(0.35 * hour)
        observed_target_mm = max(ETc_true + noise, 0.0)
        dStorage_obs_mL = inflow_mL - drain_mL - observed_target_mm * static.pot_area_m2 * 1000.0

        sensors = StepSensors(
            T_C=T_C,
            RH_pct=RH_pct,
            Rs_MJ_m2_h=Rs,
            u2_ms=u2_ms,
            theta=None,
            inflow_mL=inflow_mL,
            drain_mL=drain_mL,
            dStorage_mL=dStorage_obs_mL,
            AC_on=False,
        )

        result = simulator.step(sensors=sensors, config=cfg)
        truth_state.De_mm = De_post_true
        truth_state.Dr_mm = Dr_next_true
        truth_state.Ke_prev = Ke_true

        daily_model[day_index] += result.ETc_model_mm
        daily_observed[day_index] += observed_target_mm

    mae = sum(abs(m - o) for m, o in zip(daily_model, daily_observed)) / len(daily_model)
    print(f"Daily ET MAE [mm]: {mae:.3f}")
    return mae


if __name__ == "__main__":
    run_deterministic_demo()
