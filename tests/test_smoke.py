"""Smoke tests for the ETc controller."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ETKC_SRC = ROOT / "apps" / "hub" / "src"
if str(ETKC_SRC) not in sys.path:
    sys.path.append(str(ETKC_SRC))

from etkc.controller import step  # noqa: E402
from etkc.state import PotState, PotStatic, StepConfig, StepSensors  # noqa: E402


def test_single_step_ranges() -> None:
    static = PotStatic(
        pot_area_m2=0.0314,
        depth_m=0.25,
        theta_fc=0.32,
        theta_wp=0.12,
    )
    state = PotState()
    config = StepConfig()
    sensors = StepSensors(
        T_C=26.0,
        RH_pct=55.0,
        Rs_MJ_m2_h=1.0,
        u2_ms=0.3,
        dStorage_mL=0.0,
    )

    new_state, result = step(static, state, sensors, config)

    assert isinstance(new_state, PotState)
    assert 0.0 <= result.Kcb_eff <= 1.5
    assert 0.0 <= result.Ke <= 1.2
    assert result.ET0_mm >= 0.0
