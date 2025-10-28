import asyncio
import logging
from datetime import datetime, timedelta, timezone
from services.weather_hrrr import hrrr_weather_service

LAT, LON = 38.9444, 77.0665  # adjust as needed

async def main():
    logging.basicConfig(level=logging.INFO)
    target_when = datetime.now(timezone.utc) - timedelta(hours=2)
    sample = await hrrr_weather_service.refresh_point(
        LAT,
        LON,
        persist=False,
        when=target_when,
    )
    print()
    print("Requested valid hour:", target_when.isoformat())
    print("Resolved run:")
    print("  cycle:", sample.run.cycle.isoformat())
    print("  forecast_hour:", sample.run.forecast_hour)
    print("  valid_time:", sample.run.valid_time.isoformat())
    print()
    print("Fields:")
    for label, value in [
        ("temperature_c", sample.temperature_c),
        ("humidity_pct", sample.humidity_pct),
        ("wind_speed_m_s", sample.wind_speed_m_s),
        ("pressure_hpa", sample.pressure_hpa),
        ("solar_radiation_w_m2", sample.solar_radiation_w_m2),
        ("solar_radiation_diffuse_w_m2", sample.solar_radiation_diffuse_w_m2),
        ("solar_radiation_direct_w_m2", sample.solar_radiation_direct_w_m2),
        ("solar_radiation_clear_w_m2", sample.solar_radiation_clear_w_m2),
        ("solar_radiation_clear_up_w_m2", sample.solar_radiation_clear_up_w_m2),
    ]:
        print(f"  {label}:", value)
    await hrrr_weather_service.close()

asyncio.run(main())


