export type HubInfo = {
  name: string;
  version: string;
  debug: boolean;
  cors_origins: string[];
  mqtt_enabled: boolean;
  mqtt_host: string;
  mqtt_port: number;
};

export type TelemetrySample = {
  timestamp: string;
  temperature_c: number | null;
  humidity_pct: number | null;
  pressure_hpa: number | null;
  solar_radiation_w_m2: number | null;
  station?: string | null;
};

export type WeatherSeries = {
  samples: TelemetrySample[];
  coverageHours: number;
  availableWindows: number[];
};

export type WateringPlantProfile = {
  name?: string | null;
  crop_coefficient: number;
};

export type WateringPotProfile = {
  diameter_cm: number;
  height_cm: number;
  available_water_fraction: number;
  irrigation_efficiency: number;
  target_refill_fraction: number;
};

export type WateringClimateSummary = {
  coverage_hours: number;
  data_points: number;
  avg_temperature_c: number;
  avg_humidity_pct: number;
  avg_pressure_hpa: number;
  avg_solar_w_m2: number;
  wind_speed_m_s: number;
  net_radiation_mj_m2_day: number;
};

export type WateringPotMetrics = {
  surface_area_m2: number;
  volume_liters: number;
  available_water_liters: number;
  max_event_liters: number;
};

export type WateringOutputs = {
  et0_mm_day: number;
  etc_mm_day: number;
  daily_water_liters: number;
  adjusted_daily_liters: number;
  recommended_events_per_day: number;
  recommended_ml_per_event: number;
  recommended_ml_per_day: number;
};

export type WateringAssumptions = {
  lookback_hours: number;
  assumed_wind_speed_m_s: number;
  net_radiation_factor: number;
};

export type WateringDiagnostics = {
  notes: string[];
};

export type WateringRecommendation = {
  method: string;
  climate: WateringClimateSummary;
  plant: WateringPlantProfile;
  pot: WateringPotProfile;
  pot_metrics: WateringPotMetrics;
  outputs: WateringOutputs;
  assumptions: WateringAssumptions;
  diagnostics: WateringDiagnostics;
};

export type WateringRequestSample = {
  timestamp: string;
  temperature_c: number | null;
  humidity_pct: number | null;
  pressure_hpa: number | null;
  solar_radiation_w_m2: number | null;
  wind_speed_m_s?: number | null;
};

export type WateringRequest = {
  method?: "penman_monteith";
  lookback_hours?: number;
  assumed_wind_speed_m_s?: number;
  net_radiation_factor?: number;
  samples: WateringRequestSample[];
  plant?: {
    name?: string | null;
    crop_coefficient?: number;
  };
  pot: {
    diameter_cm: number;
    height_cm: number;
    available_water_fraction: number;
    irrigation_efficiency: number;
    target_refill_fraction: number;
  };
};

const BASE_URL = "/api/v1";

export async function fetchHubInfo(signal?: AbortSignal): Promise<HubInfo> {
  const response = await fetch(`${BASE_URL}/info`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load hub info (${response.status})`);
  }
  return (await response.json()) as HubInfo;
}

export async function fetchMockTelemetry(
  params?: { samples?: number },
  signal?: AbortSignal
): Promise<TelemetrySample[]> {
  const search = new URLSearchParams();
  if (params?.samples) {
    search.set("samples", params.samples.toString());
  }
  const requestUrl = `${BASE_URL}/mock/telemetry${search.toString() ? `?${search}` : ""}`;
  const response = await fetch(requestUrl, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load mock telemetry (${response.status})`);
  }
  const payload = (await response.json()) as { data: TelemetrySample[] };
  return payload.data;
}

export async function fetchLocalWeather(
  params: { lat: number; lon: number; hours: number },
  signal?: AbortSignal
): Promise<WeatherSeries> {
  const search = new URLSearchParams({
    lat: params.lat.toString(),
    lon: params.lon.toString(),
    hours: params.hours.toString(),
  });
  const response = await fetch(`${BASE_URL}/weather/local?${search.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load local weather (${response.status})`);
  }
  const payload = (await response.json()) as {
    data: TelemetrySample[];
    coverage_hours: number;
    available_windows: number[];
  };
  return {
    samples: payload.data ?? [],
    coverageHours: payload.coverage_hours ?? 0,
    availableWindows: payload.available_windows ?? [],
  };
}

export async function fetchWateringRecommendation(
  payload: WateringRequest,
  signal?: AbortSignal
): Promise<WateringRecommendation> {
  const response = await fetch(`${BASE_URL}/irrigation/estimate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load watering recommendation (${response.status})`);
  }
  return (await response.json()) as WateringRecommendation;
}