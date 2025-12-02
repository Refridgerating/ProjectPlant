import type { CareProfile } from "@projectplant/care-engine";

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

export type HealthStatus = "ok" | "warning" | "critical" | "disabled" | "unknown";

export type HealthSummary = {
  status: HealthStatus;
  version: string;
  uptime: {
    started_at: string | null;
    seconds: number | null;
  };
  database: {
    status: HealthStatus;
    path: string;
    exists: boolean;
    size_bytes: number | null;
    latency_ms: number | null;
    error: string | null;
  };
};

export type HeartbeatStatus = {
  pot_id: string;
  received_at: string;
  age_seconds: number;
  status: HealthStatus;
  pump_on: boolean | null;
};

export type MqttHealth = {
  enabled: boolean;
  status: HealthStatus;
  connection: {
    connected: boolean;
    reconnecting: boolean;
    host: string;
    port: number;
    client_id: string | null;
    last_connect_time: string | null;
    last_disconnect_time: string | null;
    last_disconnect_reason: string | null;
  } | null;
  heartbeat: {
    status: HealthStatus;
    count: number;
    latest_received_at: string | null;
    pots: HeartbeatStatus[];
  };
};

export type WeatherCacheHealth = {
  status: HealthStatus;
  cache_dir: string;
  file_count: number;
  bytes: number;
  latest_modified: string | null;
  oldest_modified: string | null;
  age_seconds: number | null;
  state?: string | null;
};

export type CacheEntryKind = "grib" | "metadata" | "log" | "other";
export type CacheEntriesOrder = "newest" | "oldest" | "largest" | "smallest";

export type WeatherCacheEntry = {
  path: string;
  bytes: number;
  modified: string;
  kind: CacheEntryKind;
  cycle?: string | null;
  forecast_hour?: number | null;
  valid_time?: string | null;
  domain?: string | null;
  has_metadata?: boolean | null;
};

export type WeatherCacheInventory = {
  cache_dir: string;
  total_files: number;
  total_bytes: number;
  order: CacheEntriesOrder;
  limit: number;
  entries: WeatherCacheEntry[];
};

export type WeatherCacheMutationDetail = {
  path: string;
  bytes: number | null;
  status: "deleted" | "stored" | "missing" | "error" | "skipped";
  detail?: string | null;
};

export type WeatherCacheDeleteResponse = {
  processed: number;
  bytes_removed: number;
  details: WeatherCacheMutationDetail[];
};

export type WeatherCacheStoreResponse = {
  processed: number;
  bytes_moved: number;
  destination: string;
  label: string | null;
  details: WeatherCacheMutationDetail[];
};

export type StorageHealth = {
  status: HealthStatus;
  path_checked: string;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  used_percent: number;
  free_percent: number;
};

export type AlertEvent = {
  timestamp: string;
  event_type: string;
  severity: string;
  message: string;
  detail: string | null;
  context: Record<string, unknown>;
  key?: string | null;
  recovered?: boolean;
};

export type AlertEventsResponse = {
  count: number;
  events: AlertEvent[];
};

export type TelemetrySample = {
  timestamp: string;
  temperature_c: number | null;
  temperature_max_c?: number | null;
  temperature_min_c?: number | null;
  dewpoint_c?: number | null;
  humidity_pct: number | null;
  specific_humidity_g_kg?: number | null;
  pressure_hpa: number | null;
  pressure_kpa?: number | null;
  solar_radiation_mj_m2_h?: number | null;
  solar_radiation_clear_mj_m2_h?: number | null;
  solar_radiation_diffuse_mj_m2_h?: number | null;
  solar_radiation_direct_mj_m2_h?: number | null;
  solar_radiation_w_m2: number | null;
  precip_mm_h?: number | null;
  moisture_pct?: number | null;
  wind_speed_m_s?: number | null;
  station?: string | null;
  source?: string | null;
  potId?: string | null;
  pot_id?: string | null;
  valve_open?: boolean | null;
  valveOpen?: boolean | null;
  fan_on?: boolean | null;
  fanOn?: boolean | null;
  mister_on?: boolean | null;
  misterOn?: boolean | null;
  flow_rate_lpm?: number | null;
  flowRateLpm?: number | null;
  waterLow?: boolean | null;
  waterCutoff?: boolean | null;
  soilRaw?: number | null;
  requestId?: string | null;
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
  sources: string[];
  hrrrUsed: boolean;
  hrrrError: string | null;
};

export type HrrrRunInfo = {
  cycle: string;
  forecast_hour: number;
  valid_time: string;
};

export type HrrrFields = {
  temperature_c: number | null;
  humidity_pct: number | null;
  wind_speed_m_s: number | null;
  pressure_hpa: number | null;
  solar_radiation_w_m2: number | null;
  solar_radiation_mj_m2_h: number | null;
  solar_radiation_diffuse_w_m2: number | null;
  solar_radiation_diffuse_mj_m2_h: number | null;
  solar_radiation_direct_w_m2: number | null;
  solar_radiation_direct_mj_m2_h: number | null;
  solar_radiation_clear_w_m2: number | null;
  solar_radiation_clear_mj_m2_h: number | null;
  solar_radiation_clear_up_w_m2: number | null;
  solar_radiation_clear_up_mj_m2_h: number | null;
};

export type HrrrSnapshot = {
  location: { lat: number; lon: number };
  run: HrrrRunInfo;
  fields: HrrrFields;
  source: string;
  metadata: Record<string, unknown>;
  persisted: boolean | null;
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
  fanOn?: boolean | null;
  misterOn?: boolean | null;
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

export type ControlFanOptions = {
  on: boolean;
  durationMs?: number;
  timeout?: number;
  signal?: AbortSignal;
};

export type ControlMisterOptions = {
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

export type CareSuggestionField = {
  text: string;
};

export type PlantCareSuggestions = {
  light?: CareSuggestionField | null;
  water?: CareSuggestionField | null;
  humidity?: CareSuggestionField | null;
  temperature?: CareSuggestionField | null;
  soil?: CareSuggestionField | null;
  notes?: CareSuggestionField | null;
  warning?: CareSuggestionField | null;
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
  care_profile: PlantCareProfile;
  care_suggestions: PlantCareSuggestions;
  sources: string[];
  care_profile_normalized?: CareProfile | null;
  powo_id?: string | null;
  inat_id?: number | null;
};

export type ShareRole = "owner" | "contractor" | "viewer";
export type ShareStatus = "pending" | "active" | "revoked";

export type UserAccountSummary = {
  id: string;
  email: string;
  display_name: string;
  email_verified: boolean;
  verification_pending: boolean;
  created_at: number;
  updated_at: number;
};

export type ShareParticipantRole = "owner" | "contractor";

export type ShareRecordSummary = {
  id: string;
  owner_id: string;
  contractor_id: string;
  role: ShareRole;
  status: ShareStatus;
  invite_token: string | null;
  created_at: number;
  updated_at: number;
  participant_role: ShareParticipantRole;
};

export type PotModel = {
  id: string;
  name: string;
  volume_l: number;
  features: string[];
  owner_user_id: string;
  access_role: ShareRole;
};

export type IrrigationZone = {
  id: string;
  name: string;
  irrigation_type: "drip" | "spray";
  sun_exposure: "full_sun" | "part_sun" | "shade";
  slope: boolean;
  planting_type: "lawn" | "flower_bed" | "ground_cover" | "trees";
  coverage_sq_ft: number;
  description: string;
  owner_user_id: string;
  access_role: ShareRole;
};

export type CreateIrrigationZonePayload = {
  name: string;
  irrigation_type: "drip" | "spray";
  sun_exposure: "full_sun" | "part_sun" | "shade";
  slope: boolean;
  planting_type: "lawn" | "flower_bed" | "ground_cover" | "trees";
  coverage_sq_ft?: number;
  description?: string | null;
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
  care_profile: PlantCareProfile;
  care_suggestions: PlantCareSuggestions;
  care_level: "species" | "genus" | "custom";
  care_source: string | null;
  care_warning: string | null;
  image_data?: string | null;
  owner_user_id: string;
  access_role: ShareRole;
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

import { getApiBaseUrlSync, getActiveUserIdSync } from "../settings";

function withUser(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers ?? {});
  const userId = getActiveUserIdSync();
  if (userId) {
    headers.set("X-User-Id", userId);
  }
  return { ...init, headers };
}

function apiBase(): string {
  return getApiBaseUrlSync();
}
const AGGREGATOR_BASE_URL = "/api";

export type AuthTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

export async function fetchHubInfo(signal?: AbortSignal): Promise<HubInfo> {
  const response = await fetch(`${apiBase()}/info`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load hub info (${response.status})`);
  }
  return (await response.json()) as HubInfo;
}

export async function fetchEventToken(signal?: AbortSignal): Promise<AuthTokenResponse> {
  const response = await fetch(
    `${apiBase()}/auth/token`,
    withUser({
      method: "POST",
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to obtain event token (${response.status})`);
  }
  return (await response.json()) as AuthTokenResponse;
}

export async function fetchHealthSummary(signal?: AbortSignal): Promise<HealthSummary> {
  const response = await fetch(`${apiBase()}/health`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load health summary (${response.status})`);
  }
  return (await response.json()) as HealthSummary;
}

export async function fetchMqttHealth(signal?: AbortSignal): Promise<MqttHealth> {
  const response = await fetch(`${apiBase()}/health/mqtt`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load MQTT health (${response.status})`);
  }
  return (await response.json()) as MqttHealth;
}

export async function fetchWeatherCacheHealth(signal?: AbortSignal): Promise<WeatherCacheHealth> {
  const response = await fetch(`${apiBase()}/health/weather_cache`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load HRRR cache health (${response.status})`);
  }
  return (await response.json()) as WeatherCacheHealth;
}

export async function fetchWeatherCacheEntries(
  params?: {
    limit?: number;
    order?: CacheEntriesOrder;
    kinds?: CacheEntryKind[];
  },
  signal?: AbortSignal
): Promise<WeatherCacheInventory> {
  const search = new URLSearchParams();
  if (params?.limit) {
    search.set("limit", params.limit.toString());
  }
  if (params?.order) {
    search.set("order", params.order);
  }
  if (params?.kinds?.length) {
    for (const kind of params.kinds) {
      search.append("kind", kind);
    }
  }
  const query = search.toString();
  const response = await fetch(
    `${apiBase()}/health/weather_cache/entries${query ? `?${query}` : ""}`,
    withUser({ signal })
  );
  if (!response.ok) {
    throw new Error(`Failed to load HRRR cache inventory (${response.status})`);
  }
  return (await response.json()) as WeatherCacheInventory;
}

export async function deleteWeatherCacheEntries(
  entries: string[],
  options?: { includeMetadata?: boolean }
): Promise<WeatherCacheDeleteResponse> {
  if (!entries.length) {
    throw new Error("Select at least one cache entry.");
  }
  const response = await fetch(
    `${apiBase()}/health/weather_cache/delete`,
    withUser({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entries,
        include_metadata: options?.includeMetadata ?? true,
      }),
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to delete HRRR cache entries (${response.status})`);
  }
  return (await response.json()) as WeatherCacheDeleteResponse;
}

export async function storeWeatherCacheEntries(
  entries: string[],
  options?: { includeMetadata?: boolean; label?: string }
): Promise<WeatherCacheStoreResponse> {
  if (!entries.length) {
    throw new Error("Select at least one cache entry.");
  }
  const payload: Record<string, unknown> = {
    entries,
    include_metadata: options?.includeMetadata ?? true,
  };
  if (options?.label) {
    payload.label = options.label;
  }
  const response = await fetch(
    `${apiBase()}/health/weather_cache/store`,
    withUser({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to store HRRR cache entries (${response.status})`);
  }
  return (await response.json()) as WeatherCacheStoreResponse;
}

export async function fetchStorageHealth(signal?: AbortSignal): Promise<StorageHealth> {
  const response = await fetch(`${apiBase()}/health/storage`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load storage health (${response.status})`);
  }
  return (await response.json()) as StorageHealth;
}

export async function fetchHealthEvents(
  params?: { limit?: number; severity?: string; eventType?: string[] },
  signal?: AbortSignal
): Promise<AlertEventsResponse> {
  const search = new URLSearchParams();
  if (params?.limit) {
    search.set("limit", String(params.limit));
  }
  if (params?.severity) {
    search.set("severity", params.severity);
  }
  if (params?.eventType) {
    for (const type of params.eventType) {
      if (type) {
        search.append("event_type", type);
      }
    }
  }
  const query = search.toString();
  const response = await fetch(
    `${apiBase()}/health/events${query ? `?${query}` : ""}`,
    withUser({ signal })
  );
  if (!response.ok) {
    throw new Error(`Failed to load alert events (${response.status})`);
  }
  return (await response.json()) as AlertEventsResponse;
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
  const response = await fetch(requestUrl, withUser({ signal }));
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
  const response = await fetch(requestUrl, withUser({ signal }));
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
  const response = await fetch(requestUrl, withUser({ signal }));
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
  const response = await fetch(requestUrl, withUser({ signal }));
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
  const response = await fetch(
    url,
    withUser({
      method: "POST",
      signal: options?.signal,
    })
  );

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
  const response = await fetch(
    url,
    withUser({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );

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

export async function controlFan(potId: string, options: ControlFanOptions): Promise<SensorReadResponse> {
  const trimmedId = potId.trim();
  if (!trimmedId) {
    throw new Error("Pot ID is required to control the fan");
  }

  const { on, durationMs, timeout, signal } = options;
  if (typeof on !== "boolean") {
    throw new Error("Fan command requires an on/off state");
  }

  if (durationMs !== undefined) {
    if (Number.isNaN(durationMs) || !Number.isFinite(durationMs)) {
      throw new Error("Fan duration must be a finite number of milliseconds");
    }
    if (durationMs < 0) {
      throw new Error("Fan duration must be zero or greater");
    }
  }

  if (timeout !== undefined) {
    if (Number.isNaN(timeout) || !Number.isFinite(timeout)) {
      throw new Error("Fan timeout must be a finite number of seconds");
    }
    if (timeout <= 0) {
      throw new Error("Fan timeout must be greater than zero");
    }
  }

  const payload: Record<string, unknown> = { on };
  if (durationMs !== undefined) {
    payload["durationMs"] = durationMs;
  }
  if (timeout !== undefined) {
    payload["timeout"] = timeout;
  }

  const url = `${apiBase()}/plant-control/${encodeURIComponent(trimmedId)}/fan`;
  const response = await fetch(
    url,
    withUser({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );

  if (!response.ok) {
    let message = `Failed to control fan (${response.status})`;
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

export async function controlMister(potId: string, options: ControlMisterOptions): Promise<SensorReadResponse> {
  const trimmedId = potId.trim();
  if (!trimmedId) {
    throw new Error("Pot ID is required to control the mister");
  }

  const { on, durationMs, timeout, signal } = options;
  if (typeof on !== "boolean") {
    throw new Error("Mister command requires an on/off state");
  }

  if (durationMs !== undefined) {
    if (Number.isNaN(durationMs) || !Number.isFinite(durationMs)) {
      throw new Error("Mister duration must be a finite number of milliseconds");
    }
    if (durationMs < 0) {
      throw new Error("Mister duration must be zero or greater");
    }
  }

  if (timeout !== undefined) {
    if (Number.isNaN(timeout) || !Number.isFinite(timeout)) {
      throw new Error("Mister timeout must be a finite number of seconds");
    }
    if (timeout <= 0) {
      throw new Error("Mister timeout must be greater than zero");
    }
  }

  const payload: Record<string, unknown> = { on };
  if (durationMs !== undefined) {
    payload["durationMs"] = durationMs;
  }
  if (timeout !== undefined) {
    payload["timeout"] = timeout;
  }

  const url = `${apiBase()}/plant-control/${encodeURIComponent(trimmedId)}/mister`;
  const response = await fetch(
    url,
    withUser({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );

  if (!response.ok) {
    let message = `Failed to control mister (${response.status})`;
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
  const response = await fetch(`${apiBase()}/weather/local?${search.toString()}`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load local weather (${response.status})`);
  }
  const payload = (await response.json()) as {
    data: TelemetrySample[];
    coverage_hours: number;
    available_windows: number[];
    sources?: string[] | null;
    hrrr_used?: boolean;
    hrrr_error?: string | null;
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
    sources: Array.isArray(payload.sources)
      ? payload.sources.map((source) => source.trim()).filter((source) => source.length > 0)
      : [],
    hrrrUsed: Boolean(payload.hrrr_used),
    hrrrError: payload.hrrr_error ?? null,
  };
}

export async function fetchHrrrPoint(
  params: { lat: number; lon: number; refresh?: boolean; persist?: boolean },
  signal?: AbortSignal
): Promise<HrrrSnapshot> {
  const search = new URLSearchParams({
    lat: params.lat.toString(),
    lon: params.lon.toString(),
  });
  if (params.refresh !== undefined) {
    search.set("refresh", params.refresh ? "true" : "false");
  }
  if (params.persist !== undefined) {
    search.set("persist", params.persist ? "true" : "false");
  }
  const response = await fetch(`${apiBase()}/weather/hrrr/point?${search.toString()}`, withUser({ signal }));
  if (!response.ok) {
    let message = `Failed to load HRRR snapshot (${response.status})`;
    try {
      const problem = await response.json();
      if (problem && typeof problem.detail === "string") {
        message = problem.detail;
      }
    } catch {
      // ignore
    }
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as HrrrSnapshot;
}

export async function fetchWateringRecommendation(
  payload: WateringRequest,
  signal?: AbortSignal
): Promise<WateringRecommendation> {
  const response = await fetch(
    `${apiBase()}/irrigation/estimate`,
    withUser({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );
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
  const response = await fetch(
    `${apiBase()}/plants/reference${params.toString() ? `?${params}` : ""}`,
    withUser({ signal })
  );
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
  const response = await fetch(`${AGGREGATOR_BASE_URL}/search?${params.toString()}`, withUser({ signal }));
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
  const response = await fetch(`${AGGREGATOR_BASE_URL}/plants/${encoded}`, withUser({ signal }));
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
  const response = await fetch(`${apiBase()}/plants/pots`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load smart pot models (${response.status})`);
  }
  return (await response.json()) as PotModel[];
}

export async function fetchIrrigationZones(signal?: AbortSignal): Promise<IrrigationZone[]> {
  const response = await fetch(`${apiBase()}/plants/zones`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load irrigation zones (${response.status})`);
  }
  return (await response.json()) as IrrigationZone[];
}

export async function createIrrigationZone(
  payload: CreateIrrigationZonePayload,
  signal?: AbortSignal,
): Promise<IrrigationZone> {
  const response = await fetch(
    `${apiBase()}/plants/zones`,
    withUser({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to create irrigation zone (${response.status})`);
  }
  return (await response.json()) as IrrigationZone;
}

export async function updateIrrigationZone(
  zoneId: string,
  payload: CreateIrrigationZonePayload,
  signal?: AbortSignal,
): Promise<IrrigationZone> {
  const response = await fetch(
    `${apiBase()}/plants/zones/${encodeURIComponent(zoneId)}`,
    withUser({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to update irrigation zone (${response.status})`);
  }
  return (await response.json()) as IrrigationZone;
}

export async function deleteIrrigationZone(zoneId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(
    `${apiBase()}/plants/zones/${encodeURIComponent(zoneId)}`,
    withUser({
      method: "DELETE",
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to delete irrigation zone (${response.status})`);
  }
}

export async function detectSmartPot(signal?: AbortSignal): Promise<PotModel> {
  const response = await fetch(`${apiBase()}/plants/detect-pot`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to detect smart pot (${response.status})`);
  }
  return (await response.json()) as PotModel;
}

export async function fetchPlants(signal?: AbortSignal): Promise<PlantRecord[]> {
  const response = await fetch(`${apiBase()}/plants`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load plants (${response.status})`);
  }
  return (await response.json()) as PlantRecord[];
}

export type StepSensorsSnapshot = {
  T_C: number;
  RH_pct: number;
  Rs_MJ_m2_h: number;
  u2_ms: number | null;
  theta: number | null;
  inflow_mL: number;
  drain_mL: number;
  dStorage_mL: number | null;
  AC_on: boolean;
};

export type EtkcMetricContext = {
  dt_h: number;
  pot_area_m2: number;
  sensors: StepSensorsSnapshot;
};

export type EtkcMetricMetadata = {
  telemetry?: {
    topic: string | null;
    qos: number | null;
    retain: boolean;
    received_at: string | null;
  };
  environment?: {
    source: string | null;
    label: string | null;
    timestamp: string | null;
  };
  payload?: {
    source: string | null;
    timestamp: string | null;
  };
};

export type EtkcMetric = {
  ts: number;
  ET0_mm: number;
  ETc_model_mm: number;
  ETc_obs_mm: number | null;
  Kcb_struct: number;
  Kcb_eff: number;
  c_aero: number;
  Ke: number;
  Ks: number;
  De_mm: number;
  Dr_mm: number;
  REW_mm: number;
  tau_e_h: number;
  need_irrigation: boolean;
  recommend_mm: number;
  context?: EtkcMetricContext;
  metadata?: EtkcMetricMetadata;
};

function numberOr(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function parseSensorsSnapshot(value: unknown): StepSensorsSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    T_C: numberOr(record["T_C"], 0),
    RH_pct: numberOr(record["RH_pct"], 0),
    Rs_MJ_m2_h: numberOr(record["Rs_MJ_m2_h"], 0),
    u2_ms: numberOrNull(record["u2_ms"]),
    theta: numberOrNull(record["theta"]),
    inflow_mL: numberOr(record["inflow_mL"], 0),
    drain_mL: numberOr(record["drain_mL"], 0),
    dStorage_mL: numberOrNull(record["dStorage_mL"]),
    AC_on: Boolean(record["AC_on"]),
  };
}

function parseEtkcContext(value: unknown): EtkcMetricContext | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const ctx = value as Record<string, unknown>;
  const sensors = parseSensorsSnapshot(ctx["sensors"]);
  if (!sensors) {
    return undefined;
  }
  return {
    dt_h: numberOr(ctx["dt_h"], 0),
    pot_area_m2: numberOr(ctx["pot_area_m2"], 0),
    sensors,
  };
}

function parseEtkcMetadata(value: unknown): EtkcMetricMetadata | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const meta = value as Record<string, unknown>;
  const telemetryRaw = meta["telemetry"];
  const environmentRaw = meta["environment"];
  const payloadRaw = meta["payload"];

  const telemetry =
    telemetryRaw && typeof telemetryRaw === "object"
      ? {
          topic: stringOrNull((telemetryRaw as Record<string, unknown>)["topic"]),
          qos: numberOrNull((telemetryRaw as Record<string, unknown>)["qos"]),
          retain: Boolean((telemetryRaw as Record<string, unknown>)["retain"]),
          received_at: stringOrNull((telemetryRaw as Record<string, unknown>)["received_at"]),
        }
      : undefined;

  const environment =
    environmentRaw && typeof environmentRaw === "object"
      ? {
          source: stringOrNull((environmentRaw as Record<string, unknown>)["source"]),
          label: stringOrNull((environmentRaw as Record<string, unknown>)["label"]),
          timestamp: stringOrNull((environmentRaw as Record<string, unknown>)["timestamp"]),
        }
      : undefined;

  const payload =
    payloadRaw && typeof payloadRaw === "object"
      ? {
          source: stringOrNull((payloadRaw as Record<string, unknown>)["source"]),
          timestamp: stringOrNull((payloadRaw as Record<string, unknown>)["timestamp"]),
        }
      : undefined;

  if (!telemetry && !environment && !payload) {
    return undefined;
  }

  return { telemetry, environment, payload };
}

export async function fetchEtkcMetrics(
  plantId: string,
  sinceIso?: string,
  signal?: AbortSignal
): Promise<EtkcMetric[]> {
  const trimmed = plantId.trim();
  if (!trimmed) {
    throw new Error("Plant identifier is required");
  }
  const params = new URLSearchParams();
  if (sinceIso) {
    params.set("since", sinceIso);
  }
  const response = await fetch(
    `${apiBase()}/etkc/metrics/${encodeURIComponent(trimmed)}${params.toString() ? `?${params}` : ""}`,
    withUser({ signal })
  );
  if (!response.ok) {
    throw new Error(`Failed to load ETkc metrics (${response.status})`);
  }
  const payload = (await response.json()) as Array<Record<string, unknown>>;
  return payload.map((item) => ({
    ts: typeof item["ts"] === "number" ? (item["ts"] as number) : Number(item["ts"] ?? 0),
    ET0_mm: Number(item["ET0_mm"] ?? 0),
    ETc_model_mm: Number(item["ETc_model_mm"] ?? 0),
    ETc_obs_mm: item["ETc_obs_mm"] === null || item["ETc_obs_mm"] === undefined ? null : Number(item["ETc_obs_mm"]),
    Kcb_struct: Number(item["Kcb_struct"] ?? 0),
    Kcb_eff: Number(item["Kcb_eff"] ?? 0),
    c_aero: Number(item["c_aero"] ?? 0),
    Ke: Number(item["Ke"] ?? 0),
    Ks: Number(item["Ks"] ?? 0),
    De_mm: Number(item["De_mm"] ?? 0),
    Dr_mm: Number(item["Dr_mm"] ?? 0),
    REW_mm: Number(item["REW_mm"] ?? 0),
    tau_e_h: Number(item["tau_e_h"] ?? 0),
    need_irrigation: Boolean(item["need_irrigation"]),
    recommend_mm: Number(item["recommend_mm"] ?? 0),
    context: parseEtkcContext(item["context"]),
    metadata: parseEtkcMetadata(item["metadata"]),
  }));
}

export async function createPlant(
  payload: CreatePlantPayload,
  signal?: AbortSignal
): Promise<PlantRecord> {
  const response = await fetch(
    `${apiBase()}/plants`,
    withUser({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to create plant (${response.status})`);
  }
  return (await response.json()) as PlantRecord;
}

export type CreateUserPayload = {
  email: string;
  display_name?: string;
  password: string;
  confirm_password: string;
};

export type UpdateUserPayload = {
  email?: string;
  display_name?: string;
};

export type CreateSharePayload = {
  contractor_id: string;
  role?: ShareRole;
  status?: ShareStatus;
  invite_token?: string | null;
};

export type UpdateSharePayload = {
  role?: ShareRole;
  status?: ShareStatus;
};

export async function fetchUsers(signal?: AbortSignal): Promise<UserAccountSummary[]> {
  const response = await fetch(`${apiBase()}/users`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load users (${response.status})`);
  }
  return (await response.json()) as UserAccountSummary[];
}

export async function createUserAccount(
  payload: CreateUserPayload,
  signal?: AbortSignal
): Promise<UserAccountSummary> {
  const response = await fetch(
    `${apiBase()}/users`,
    withUser({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to create user (${response.status})`);
  }
  return (await response.json()) as UserAccountSummary;
}

export async function verifyUserAccount(
  userId: string,
  token: string,
  signal?: AbortSignal
): Promise<UserAccountSummary> {
  const response = await fetch(
    `${apiBase()}/users/${encodeURIComponent(userId)}/verify`,
    withUser({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to verify user (${response.status})`);
  }
  return (await response.json()) as UserAccountSummary;
}

export async function fetchCurrentUser(signal?: AbortSignal): Promise<UserAccountSummary> {
  const response = await fetch(`${apiBase()}/users/me`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load current user (${response.status})`);
  }
  return (await response.json()) as UserAccountSummary;
}

export async function updateUserAccount(
  userId: string,
  payload: UpdateUserPayload,
  signal?: AbortSignal
): Promise<UserAccountSummary> {
  const response = await fetch(
    `${apiBase()}/users/${encodeURIComponent(userId)}`,
    withUser({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to update user (${response.status})`);
  }
  return (await response.json()) as UserAccountSummary;
}

export async function deleteUserAccount(userId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(
    `${apiBase()}/users/${encodeURIComponent(userId)}`,
    withUser({
      method: "DELETE",
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to delete user (${response.status})`);
  }
}

export async function fetchMyShares(signal?: AbortSignal): Promise<ShareRecordSummary[]> {
  const response = await fetch(`${apiBase()}/users/me/shares`, withUser({ signal }));
  if (!response.ok) {
    throw new Error(`Failed to load shares (${response.status})`);
  }
  return (await response.json()) as ShareRecordSummary[];
}

export async function createShare(
  payload: CreateSharePayload,
  signal?: AbortSignal
): Promise<ShareRecordSummary> {
  const response = await fetch(
    `${apiBase()}/users/me/shares`,
    withUser({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to create share (${response.status})`);
  }
  return (await response.json()) as ShareRecordSummary;
}

export async function updateShare(
  shareId: string,
  payload: UpdateSharePayload,
  signal?: AbortSignal
): Promise<ShareRecordSummary> {
  const response = await fetch(
    `${apiBase()}/users/me/shares/${encodeURIComponent(shareId)}`,
    withUser({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to update share (${response.status})`);
  }
  return (await response.json()) as ShareRecordSummary;
}

export async function deleteShare(shareId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(
    `${apiBase()}/users/me/shares/${encodeURIComponent(shareId)}`,
    withUser({
      method: "DELETE",
      signal,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to delete share (${response.status})`);
  }
}
