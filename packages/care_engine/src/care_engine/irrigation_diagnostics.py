from __future__ import annotations


def build_irrigation_diagnostic_notes(
    *,
    has_solar_radiation: bool,
    has_wind_speed: bool,
    assumed_wind_speed_m_s: float,
    daily_water_liters: float,
    max_event_liters: float,
) -> list[str]:
    notes: list[str] = []
    if not has_solar_radiation:
        notes.append("Solar radiation missing; net radiation scaled from configured factor.")
    if not has_wind_speed:
        notes.append(
            f"Wind speed unavailable; assumed {assumed_wind_speed_m_s:.2f} m/s for Penman-Monteith denominator."
        )
    if daily_water_liters <= 0:
        notes.append("Computed evapotranspiration is negligible; irrigation not required for the selected window.")
    if max_event_liters <= 0:
        notes.append("Pot available water storage is zero or negative; check substrate parameters.")
    return notes
