"""FAO-56 Penman-Monteith reference evapotranspiration utilities (SI units)."""

from dataclasses import dataclass
from math import exp
from typing import Final

SECONDS_PER_HOUR: Final[float] = 3600.0
W_M2_TO_MJ_M2_H: Final[float] = 0.0036
EPSILON: Final[float] = 0.622
CP_AIR: Final[float] = 1013.0  # J kg^-1 K^-1
LATENT_HEAT_VAPORIZATION: Final[float] = 2_450_000.0  # J kg^-1
MIN_RELATIVE_HUMIDITY: Final[float] = 1.0e-3
MAX_RELATIVE_HUMIDITY: Final[float] = 0.999
MIN_RELATIVE_HUMIDITY_PERCENT: Final[float] = MIN_RELATIVE_HUMIDITY * 100.0
MAX_RELATIVE_HUMIDITY_PERCENT: Final[float] = MAX_RELATIVE_HUMIDITY * 100.0


def sat_vapor_pressure_kPa(T_C: float) -> float:
    """Return saturation vapor pressure at air temperature ``T_C`` [kPa]."""

    denominator = T_C + 237.3
    if denominator == 0.0:
        raise ValueError("Temperature of -237.3 degC leads to singular saturation vapor pressure.")
    return 0.6108 * exp((17.27 * T_C) / denominator)


def slope_delta_kPa_perC(T_C: float) -> float:
    """Return slope of saturation vapor pressure curve at ``T_C`` [kPa degC^-1]."""

    denominator = (T_C + 237.3) ** 2
    if denominator == 0.0:
        raise ValueError("Temperature of -237.3 degC leads to singular saturation vapor pressure slope.")
    es = sat_vapor_pressure_kPa(T_C)
    return 4098.0 * es / denominator


def psychrometric_constant_kPa_perC(P_kPa: float = 101.3) -> float:
    """Return psychrometric constant gamma for pressure ``P_kPa`` [kPa degC^-1]."""

    if P_kPa <= 0.0:
        raise ValueError("Atmospheric pressure must be positive.")
    pressure_pa = P_kPa * 1000.0
    gamma_pa_per_C = (CP_AIR * pressure_pa) / (EPSILON * LATENT_HEAT_VAPORIZATION)
    return gamma_pa_per_C / 1000.0


def vpd_kPa(T_C: float, RH_pct: float) -> float:
    """Return vapor pressure deficit for ``T_C`` and relative humidity ``RH_pct`` [kPa]."""

    rh_clamped = max(MIN_RELATIVE_HUMIDITY_PERCENT, min(MAX_RELATIVE_HUMIDITY_PERCENT, RH_pct))
    es = sat_vapor_pressure_kPa(T_C)
    ea = es * (rh_clamped / 100.0)
    return max(es - ea, 0.0)


def fao56_pm_hourly(
    T_C: float,
    RH_pct: float,
    Rs_MJ_m2_h: float,
    u2_ms: float | None = None,
    P_kPa: float | None = None,
    albedo: float = 0.23,
) -> float:
    """
    Return FAO-56 Penman-Monteith reference ET0 for an hourly step [mm h^-1].

    Args:
        T_C: Mean air temperature for the hour [degC].
        RH_pct: Mean relative humidity for the hour [%].
        Rs_MJ_m2_h: Shortwave solar radiation [MJ m^-2 h^-1].
        u2_ms: Wind speed at 2 m height [m s^-1]. Defaults to 0.25 m s^-1 when ``None``.
        P_kPa: Mean atmospheric pressure [kPa]. Defaults to 101.3 kPa when ``None``.
        albedo: Shortwave albedo of the crop surface [-].
    """

    u2 = 0.25 if u2_ms is None else max(u2_ms, 0.0)
    pressure_kPa = 101.3 if P_kPa is None else P_kPa
    net_radiation = max(0.0, 1.0 - max(min(albedo, 1.0), 0.0)) * max(Rs_MJ_m2_h, 0.0)

    delta = slope_delta_kPa_perC(T_C)
    gamma = psychrometric_constant_kPa_perC(pressure_kPa)
    vpd = vpd_kPa(T_C, RH_pct)

    temp_kelvin = T_C + 273.15
    if temp_kelvin <= 0.0:
        raise ValueError("Absolute temperature must be above 0 K.")

    radiation_term = 0.408 * delta * net_radiation
    aerodynamic_term = gamma * (37.0 / temp_kelvin) * u2 * vpd
    denominator = delta + gamma * (1.0 + 0.34 * u2)
    if denominator <= 0.0:
        raise ValueError("Invalid meteorological combination leading to zero denominator.")

    et0 = (radiation_term + aerodynamic_term) / denominator
    return max(et0, 0.0)


@dataclass(frozen=True)
class WeatherSample:
    """Meteorological snapshot for Penman-Monteith ET0.

    Args:
        air_temp_c: Dry bulb air temperature [degC].
        relative_humidity: Mean relative humidity as a fraction [0-1].
        pressure_kpa: Atmospheric pressure [kPa].
        wind_speed_m_s: Wind speed measured at 2 m height [m s^-1].
        net_radiation_w_m2: Net radiation at the crop surface [W m^-2].
        soil_heat_flux_w_m2: Soil (or substrate) heat flux density [W m^-2].
    """

    air_temp_c: float
    relative_humidity: float
    pressure_kpa: float
    wind_speed_m_s: float
    net_radiation_w_m2: float
    soil_heat_flux_w_m2: float = 0.0


@dataclass(frozen=True)
class ReferenceET0:
    """Reference evapotranspiration diagnostic container.

    Attributes:
        depth_mm: Depth of reference evapotranspiration over the interval [mm].
        rate_mm_per_hour: Mean ET0 rate for the interval [mm h^-1].
    """

    depth_mm: float
    rate_mm_per_hour: float


def saturation_vapor_pressure(temp_c: float) -> float:
    """Return the saturation vapor pressure at ``temp_c`` [kPa]."""

    return sat_vapor_pressure_kPa(temp_c)


def slope_saturation_vapor_pressure_curve(temp_c: float) -> float:
    """Return the slope of the saturation vapor pressure curve at ``temp_c`` [kPa K^-1]."""

    return slope_delta_kPa_perC(temp_c)


def psychrometric_constant(pressure_kpa: float) -> float:
    """Return the psychrometric constant gamma for the given pressure [kPa K^-1]."""

    return psychrometric_constant_kPa_perC(pressure_kpa)


def vapor_pressure_deficit(temp_c: float, relative_humidity: float) -> float:
    """Return the vapor pressure deficit for ``temp_c`` and ``relative_humidity`` [kPa]."""

    rh_fraction = min(max(relative_humidity, 0.0), 1.0)
    rh_fraction = max(MIN_RELATIVE_HUMIDITY, min(MAX_RELATIVE_HUMIDITY, rh_fraction))
    return vpd_kPa(temp_c, rh_fraction * 100.0)


def reference_et0(weather: WeatherSample, time_step_seconds: float = SECONDS_PER_HOUR) -> ReferenceET0:
    """Compute FAO-56 hourly reference ET0 using the Penman-Monteith formulation.

    Args:
        weather: Meteorological inputs (see :class:`WeatherSample`).
        time_step_seconds: Integration interval used for ``weather`` [s].

    Returns:
        ReferenceET0: Reference evapotranspiration depth [mm] and rate [mm h^-1].

    Raises:
        ValueError: If ``time_step_seconds`` is not positive or inputs are inconsistent.
    """

    if time_step_seconds <= 0.0:
        raise ValueError("time_step_seconds must be positive.")

    duration_hours = time_step_seconds / SECONDS_PER_HOUR
    rn_rate_mj = weather.net_radiation_w_m2 * W_M2_TO_MJ_M2_H
    g_rate_mj = weather.soil_heat_flux_w_m2 * W_M2_TO_MJ_M2_H
    delta = slope_saturation_vapor_pressure_curve(weather.air_temp_c)
    gamma = psychrometric_constant(weather.pressure_kpa)
    vpd = vapor_pressure_deficit(weather.air_temp_c, weather.relative_humidity)
    temp_k = weather.air_temp_c + 273.15
    radiation_term = 0.408 * delta * (rn_rate_mj - g_rate_mj)
    aerodynamic_term = gamma * (37.0 / temp_k) * weather.wind_speed_m_s * vpd
    denominator = delta + gamma * (1.0 + 0.34 * weather.wind_speed_m_s)
    if denominator <= 0.0:
        raise ValueError("Invalid meteorological combination leading to zero denominator.")

    et0_rate = max(0.0, (radiation_term + aerodynamic_term) / denominator)
    depth_mm = et0_rate * duration_hours
    return ReferenceET0(depth_mm=depth_mm, rate_mm_per_hour=et0_rate)
