from care_engine.evapotranspiration import PlantParams, PotParams
from services.weather.eto import estimate_reference_et, weather_samples_to_climate
from services.weather.schemas import WeatherSample


def test_weather_samples_to_climate_skips_samples_without_timestamp() -> None:
    samples = [
        WeatherSample(
            timestamp="2026-04-24T12:00:00Z",
            temperature_c=22.0,
            humidity_pct=55.0,
            pressure_hpa=1012.0,
            solar_radiation_w_m2=420.0,
            wind_speed_m_s=2.0,
        ),
        WeatherSample(temperature_c=23.0, humidity_pct=50.0),
    ]

    climate = weather_samples_to_climate(samples)

    assert len(climate) == 1
    assert climate[0].temperature_c == 22.0
    assert climate[0].solar_radiation_w_m2 == 420.0


def test_estimate_reference_et_uses_existing_penman_monteith_engine() -> None:
    samples = [
        WeatherSample(
            timestamp="2026-04-24T12:00:00Z",
            temperature_c=22.0,
            humidity_pct=55.0,
            pressure_hpa=1012.0,
            solar_radiation_w_m2=420.0,
            wind_speed_m_s=2.0,
        ),
        WeatherSample(
            timestamp="2026-04-24T13:00:00Z",
            temperature_c=24.0,
            humidity_pct=52.0,
            pressure_hpa=1011.0,
            solar_radiation_w_m2=500.0,
            wind_speed_m_s=2.2,
        ),
    ]

    result = estimate_reference_et(
        samples,
        PlantParams(crop_coefficient=1.0, name="test plant"),
        PotParams(
            diameter_cm=20.0,
            height_cm=18.0,
            available_water_fraction=0.2,
            irrigation_efficiency=0.8,
            target_refill_fraction=0.5,
        ),
        lookback_hours=2.0,
    )

    assert result.climate.data_points == 2
    assert result.climate.avg_solar_w_m2 > 0
    assert result.outputs.et0_mm_day > 0
