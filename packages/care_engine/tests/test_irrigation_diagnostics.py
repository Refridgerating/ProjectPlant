from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from care_engine.irrigation_diagnostics import build_irrigation_diagnostic_notes


def test_irrigation_diagnostics_reports_missing_inputs() -> None:
    notes = build_irrigation_diagnostic_notes(
        has_solar_radiation=False,
        has_wind_speed=False,
        assumed_wind_speed_m_s=0.12,
        daily_water_liters=0.0,
        max_event_liters=0.0,
    )

    assert "Solar radiation missing; net radiation scaled from configured factor." in notes
    assert "Wind speed unavailable; assumed 0.12 m/s for Penman-Monteith denominator." in notes
    assert "Computed evapotranspiration is negligible; irrigation not required for the selected window." in notes
    assert "Pot available water storage is zero or negative; check substrate parameters." in notes


def test_irrigation_diagnostics_is_empty_for_complete_positive_inputs() -> None:
    assert (
        build_irrigation_diagnostic_notes(
            has_solar_radiation=True,
            has_wind_speed=True,
            assumed_wind_speed_m_s=0.1,
            daily_water_liters=0.2,
            max_event_liters=0.1,
        )
        == []
    )
