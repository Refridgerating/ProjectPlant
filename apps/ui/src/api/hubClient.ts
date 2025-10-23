export type HubInfo = {
  name: string;
  version: string;
  debug: boolean;
  cors_origins: string[];
  mqtt_enabled: boolean;
  mqtt_host: string;
  mqtt_port: number;
  pot_telemetry_retention_hours: number;
  pot_telemetry_max_rows: number;
};

export type TelemetrySample = {
  timestamp: string;
  temperature_c: number | null;
  humidity_pct: number | null;
  pressure_hpa: number | null;
  solar_radiation_w_m2: number | null;
  moisture_pct?: number | null;
  wind_speed_m_s?: number | null;
  station?: string | null;
  source?: string | null;
};

export type WeatherStation = {
  id: string | null;
  name: string | null;
  identifier: string | null;
  lat: number | null;
  lon: number | null;
  distanceKm: number | null;
};

export type WeatherSeries = {
  samples: TelemetrySample[];
  coverageHours: number;
  availableWindows: number[];
  station: WeatherStation | null;
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

export type SensorReadPayload = {
  potId: string;
  moisture: number;
  temperature: number;
  valveOpen: boolean;
  timestamp: string;
  humidity?: number | null;
  flowRateLpm?: number | null;
  waterLow?: boolean | null;
  waterCutoff?: boolean | null;
  soilRaw?: number | null;
  timestampMs?: number | null;
  [key: string]: unknown;
};

export type SensorReadResponse = {
  payload: SensorReadPayload;
  requestId: string | null;
};

export type RequestSensorReadOptions = {
  timeout?: number;
  signal?: AbortSignal;
};

export type ControlPumpOptions = {
  on: boolean;
  durationMs?: number;
  timeout?: number;
  signal?: AbortSignal;
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

export type PlantReference = {
  species: string;
  common_name: string;
  light: string;
  water: string;
  humidity: string;
  temperature_c: [number, number];
  ph_range: [number, number];
  notes: string;
};

export type PlantSuggestion = {
  id: string;
  scientific_name: string;
  common_name: string | null;
  sources: string[];
  rank: string | null;
  image_url: string | null;
  summary: string | null;
};

export type PlantCareProfile = {
  light: string;
  water: string;
  humidity: string;
  temperature_c: [number, number];
  ph_range: [number, number];
  notes: string | null;
  level: "species" | "genus" | "custom";
  source: string | null;
  warning: string | null;
  allow_user_input?: boolean | null;
  soil?: string | null;
  spacing?: string | null;
  lifecycle?: string | null;
};

export type PlantDetails = {
  id: string;
  scientific_name: string;
  common_name: string | null;
  family: string | null;
  genus: string | null;
  rank: string | null;
  synonyms: string[];
  distribution: string[];
  summary: string | null;
  taxonomy: Record<string, string>;
  image_url: string | null;
  images: string[];
  care: PlantCareProfile;
  sources: string[];
};

export type PotModel = {
  id: string;
  name: string;
  volume_l: number;
  features: string[];
};

export type IrrigationZone = {
  id: string;
  name: string;
  description: string;
  coverage_sq_ft: number;
};

export type PlantRecord = {
  id: number;
  nickname: string;
  species: string;
  common_name: string;
  location_type: "smart_pot" | "garden";
  pot_model: string | null;
  irrigation_zone_id: string | null;
  taxonomy: Record<string, string>;
  summary: string | null;
  image_url: string | null;
  ideal_conditions: {
    light: string;
    water: string;
    humidity: string;
    temperature_c: [number, number];
    ph_range: [number, number];
    notes: string | null;
  };
  care_level: "species" | "genus" | "custom";
  care_source: string | null;
  care_warning: string | null;
  image_data?: string | null;
};
export type CreatePlantPayload = {
  nickname: string;
  species: string;
  location_type: "smart_pot" | "garden";
  pot_model?: string | null;
  irrigation_zone_id?: string | null;
  image_data?: string | null;
  taxonomy?: Record<string, string> | null;
  summary?: string | null;
  image_url?: string | null;
  care_profile?: PlantCareProfile | null;
};

import { getApiBaseUrlSync } from "../settings";

function apiBase(): string {
  return getApiBaseUrlSync();
}
const AGGREGATOR_BASE_URL = "/api";

export async function fetchHubInfo(signal?: AbortSignal): Promise<HubInfo> {
  const response = await fetch(`${apiBase()}/info`, { signal });
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
  const requestUrl = `${apiBase()}/mock/telemetry${search.toString() ? `?${search}` : ""}`;
  const response = await fetch(requestUrl, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load mock telemetry (${response.status})`);
  }
  const payload = (await response.json()) as { data: TelemetrySample[] };
  return payload.data.map((sample) => ({
    ...sample,
    temperature_c: sample.temperature_c ?? null,
    humidity_pct: sample.humidity_pct ?? null,
    pressure_hpa: sample.pressure_hpa ?? null,
    solar_radiation_w_m2: sample.solar_radiation_w_m2 ?? null,
    moisture_pct: sample.moisture_pct ?? null,
    wind_speed_m_s: sample.wind_speed_m_s ?? null,
    station: sample.station ?? null,
    source: sample.source ?? null,
  }));
}

export async function fetchLiveTelemetry(
  params?: { hours?: number; limit?: number },
  signal?: AbortSignal
): Promise<TelemetrySample[]> {
  const search = new URLSearchParams();
  if (params?.hours) {
    search.set("hours", params.hours.toString());
  }
  if (params?.limit) {
    search.set("limit", params.limit.toString());
  }
  const requestUrl = `${apiBase()}/telemetry/live${search.toString() ? `?${search}` : ""}`;
  const response = await fetch(requestUrl, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load live telemetry (${response.status})`);
  }
  const payload = (await response.json()) as { data?: TelemetrySample[] };
  return (payload.data ?? []).map((entry) => ({
    timestamp: entry.timestamp ?? "",
    temperature_c: entry.temperature_c ?? null,
    humidity_pct: entry.humidity_pct ?? null,
    pressure_hpa: entry.pressure_hpa ?? null,
    solar_radiation_w_m2: entry.solar_radiation_w_m2 ?? null,
    moisture_pct: entry.moisture_pct ?? null,
    wind_speed_m_s: entry.wind_speed_m_s ?? null,
    station: entry.station ?? null,
    source: entry.source ?? null,
  }));
}

export async function fetchPotTelemetry(
  potId: string,
  params?: { hours?: number; limit?: number },
  signal?: AbortSignal
): Promise<TelemetrySample[]> {
  const trimmed = potId.trim();
  if (!trimmed) {
    return [];
  }
  const search = new URLSearchParams();
  if (params?.hours) {
    search.set("hours", params.hours.toString());
  }
  if (params?.limit) {
    search.set("limit", params.limit.toString());
  }
  const requestUrl = `${apiBase()}/telemetry/pots/${encodeURIComponent(trimmed)}${
    search.toString() ? `?${search}` : ""
  }`;
  const response = await fetch(requestUrl, { signal });
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`Failed to load pot telemetry (${response.status})`);
  }
  const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
  const samples = Array.isArray(payload.data) ? payload.data : [];
  return samples.map((entry) => ({
    timestamp: typeof entry["timestamp"] === "string" ? entry["timestamp"] : "",
    temperature_c: _readNumber(entry["temperature_c"] ?? entry["temperature"]),
    humidity_pct: _readNumber(entry["humidity_pct"] ?? entry["humidity"]),
    pressure_hpa: _readNumber(entry["pressure_hpa"] ?? entry["pressure"]),
    solar_radiation_w_m2: _readNumber(entry["solar_radiation_w_m2"] ?? entry["solar"]),
    moisture_pct: _readNumber(entry["moisture_pct"] ?? entry["moisture"]),
    wind_speed_m_s: _readNumber(entry["wind_speed_m_s"] ?? entry["wind"]),
    station: typeof entry["potId"] === "string" ? entry["potId"] : null,
    source: typeof entry["source"] === "string" ? entry["source"] : null,
  }));
}

type PotTelemetryExportOptions = {
  hours?: number;
  limit?: number;
  format?: "csv";
  signal?: AbortSignal;
};

export async function exportPotTelemetry(
  potId: string,
  { hours, limit, format = "csv", signal }: PotTelemetryExportOptions = {}
): Promise<{ blob: Blob; filename: string }> {
  const trimmed = potId.trim();
  if (!trimmed) {
    throw new Error("Pot identifier is required for export");
  }
  const search = new URLSearchParams();
  if (hours != null) {
    search.set("hours", hours.toString());
  }
  if (limit != null) {
    search.set("limit", limit.toString());
  }
  if (format) {
    search.set("format", format);
  }
  const requestUrl = `${apiBase()}/telemetry/pots/${encodeURIComponent(trimmed)}/export${
    search.toString() ? `?${search}` : ""
  }`;
  const response = await fetch(requestUrl, { signal });
  if (!response.ok) {
    let message = `Failed to export pot telemetry (${response.status})`;
    try {
      const payload = await response.json();
      if (payload && typeof payload["detail"] === "string") {
        message = payload["detail"];
      }
    } catch {
      // ignore parse failure and fall back to generic message
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const filename =
    _parseContentDispositionFilename(response.headers.get("content-disposition")) ??
    `pot-${trimmed}-telemetry.${format === "csv" ? "csv" : "dat"}`;
  return { blob, filename };
}

function _readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function _parseContentDispositionFilename(header: string | null): string | undefined {
  if (!header) {
    return undefined;
  }
  const starMatch = header.match(/filename\*=([^;]+)/i);
  if (starMatch?.[1]) {
    const raw = starMatch[1].trim();
    const [, value = raw] = raw.split("''");
    const unquoted = value.replace(/^["']|["']$/g, "");
    try {
      return decodeURIComponent(unquoted);
    } catch {
      return unquoted;
    }
  }
  const match = header.match(/filename="?([^";]+)"?/i);
  if (match?.[1]) {
    return match[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

export async function requestSensorRead(
  potId: string,
  options?: RequestSensorReadOptions
): Promise<SensorReadResponse> {
  const trimmedId = potId.trim();
  if (!trimmedId) {
    throw new Error("Pot ID is required");
  }

  const search = new URLSearchParams();
  if (options?.timeout) {
    search.set("timeout", options.timeout.toString());
  }
  const url = `${apiBase()}/plant-control/${encodeURIComponent(trimmedId)}/sensor-read${
    search.toString() ? `?${search}` : ""
  }`;
  const response = await fetch(url, {
    method: "POST",
    signal: options?.signal,
  });

  if (!response.ok) {
    let message = `Failed to request sensor read (${response.status})`;
    try {
      const problem = await response.json();
      if (problem && typeof problem.detail === "string") {
        message = problem.detail;
      }
    } catch {
      // ignore error payload parsing failures
    }
    throw new Error(message);
  }

  const payload = (await response.json()) as SensorReadPayload;
  const requestId = response.headers.get("x-command-request-id");
  return { payload, requestId };
}

export async function controlPump(potId: string, options: ControlPumpOptions): Promise<SensorReadResponse> {
  const trimmedId = potId.trim();
  if (!trimmedId) {
    throw new Error("Pot ID is required to control the pump");
  }

  const { on, durationMs, timeout, signal } = options;
  if (typeof on !== "boolean") {
    throw new Error("Pump command requires an on/off state");
  }

  if (durationMs !== undefined) {
    if (Number.isNaN(durationMs) || !Number.isFinite(durationMs)) {
      throw new Error("Pump duration must be a finite number of milliseconds");
    }
    if (durationMs <= 0) {
      throw new Error("Pump duration must be greater than zero");
    }
  }

  if (timeout !== undefined) {
    if (Number.isNaN(timeout) || !Number.isFinite(timeout)) {
      throw new Error("Pump timeout must be a finite number of seconds");
    }
    if (timeout <= 0) {
      throw new Error("Pump timeout must be greater than zero");
    }
  }

  const payload: Record<string, unknown> = { on };
  if (durationMs !== undefined) {
    payload["durationMs"] = durationMs;
  }
  if (timeout !== undefined) {
    payload["timeout"] = timeout;
  }

  const url = `${apiBase()}/plant-control/${encodeURIComponent(trimmedId)}/pump`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    let message = `Failed to control pump (${response.status})`;
    try {
      const problem = await response.json();
      if (problem && typeof problem.detail === "string") {
        message = problem.detail;
      }
    } catch {
      // ignore JSON parsing errors
    }
    throw new Error(message);
  }

  const payloadJson = (await response.json()) as SensorReadPayload;
  const requestId = response.headers.get("x-command-request-id");
  return { payload: payloadJson, requestId };
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
  const response = await fetch(`${apiBase()}/weather/local?${search.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load local weather (${response.status})`);
  }
  const payload = (await response.json()) as {
    data: TelemetrySample[];
    coverage_hours: number;
    available_windows: number[];
    station?: {
      id?: string | null;
      name?: string | null;
      identifier?: string | null;
      lat?: number | null;
      lon?: number | null;
      distance_km?: number | null;
    } | null;
  };
  const station = payload.station
    ? {
        id: payload.station.id ?? null,
        name: payload.station.name ?? null,
        identifier: payload.station.identifier ?? null,
        lat: payload.station.lat ?? null,
        lon: payload.station.lon ?? null,
        distanceKm: payload.station.distance_km ?? null,
      }
    : null;
  return {
    samples: payload.data ?? [],
    coverageHours: payload.coverage_hours ?? 0,
    availableWindows: payload.available_windows ?? [],
    station,
  };
}

export async function fetchWateringRecommendation(
  payload: WateringRequest,
  signal?: AbortSignal
): Promise<WateringRecommendation> {
  const response = await fetch(`${apiBase()}/irrigation/estimate`, {
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

export async function fetchPlantReferences(search?: string, signal?: AbortSignal): Promise<PlantReference[]> {
  const params = new URLSearchParams();
  if (search) {
    params.set("search", search);
  }
  const response = await fetch(`${apiBase()}/plants/reference${params.toString() ? `?${params}` : ""}`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load plant references (${response.status})`);
  }
  return (await response.json()) as PlantReference[];
}

export async function suggestPlants(query: string, signal?: AbortSignal): Promise<PlantSuggestion[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const params = new URLSearchParams({ q: trimmed });
  const response = await fetch(`${AGGREGATOR_BASE_URL}/search?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load plant suggestions (${response.status})`);
  }
  const payload = (await response.json()) as Array<Record<string, unknown>>;
  return payload.map((item) => {
    const sources =
      Array.isArray(item["sources"]) && item["sources"].length
        ? (item["sources"] as string[])
        : typeof item["source"] === "string"
        ? [item["source"] as string]
        : [];
    return {
      id: String(item["id"] ?? ""),
      scientific_name: String(item["scientific_name"] ?? ""),
      common_name: (item["common_name"] as string | null | undefined) ?? null,
      sources,
      rank: (item["rank"] as string | null | undefined) ?? null,
      image_url: (item["image_url"] as string | null | undefined) ?? null,
      summary: (item["summary"] as string | null | undefined) ?? null,
    } as PlantSuggestion;
  });
}

export async function fetchPlantDetails(id: string, signal?: AbortSignal): Promise<PlantDetails> {
  const slug = id.trim();
  if (!slug) {
    throw new Error("Plant identifier is required");
  }
  const encoded = encodeURIComponent(slug);
  const response = await fetch(`${AGGREGATOR_BASE_URL}/plants/${encoded}`, { signal });
  if (!response.ok) {
    let message = `Failed to load plant details (${response.status})`;
    try {
      const payload = await response.json();
      if (payload && typeof payload.detail === "string") {
        message = payload.detail;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }
  return (await response.json()) as PlantDetails;
}

export async function fetchPotModels(signal?: AbortSignal): Promise<PotModel[]> {
  const response = await fetch(`${apiBase()}/plants/pots`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load smart pot models (${response.status})`);
  }
  return (await response.json()) as PotModel[];
}

export async function fetchIrrigationZones(signal?: AbortSignal): Promise<IrrigationZone[]> {
  const response = await fetch(`${apiBase()}/plants/zones`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load irrigation zones (${response.status})`);
  }
  return (await response.json()) as IrrigationZone[];
}

export async function detectSmartPot(signal?: AbortSignal): Promise<PotModel> {
  const response = await fetch(`${apiBase()}/plants/detect-pot`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to detect smart pot (${response.status})`);
  }
  return (await response.json()) as PotModel;
}

export async function fetchPlants(signal?: AbortSignal): Promise<PlantRecord[]> {
  const response = await fetch(`${apiBase()}/plants`, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load plants (${response.status})`);
  }
  return (await response.json()) as PlantRecord[];
}

export async function createPlant(
  payload: CreatePlantPayload,
  signal?: AbortSignal
): Promise<PlantRecord> {
  const response = await fetch(`${apiBase()}/plants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to create plant (${response.status})`);
  }
  return (await response.json()) as PlantRecord;
}

