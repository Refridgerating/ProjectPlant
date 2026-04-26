import type {
  AssumptionsModel,
  ClimateSampleModel,
  ClimateSummaryModel,
  DiagnosticsModel,
  HrrrSnapshot,
  IrrigationOutputsModel,
  IrrigationRequest,
  IrrigationResponse,
  PlantProfileModel,
  PotMetricsModel,
  PotProfileModel,
  WeatherLocationResponse,
  WeatherLocationUpsertRequest,
  WeatherResponse,
  WeatherTelemetry,
  paths,
} from "../generated/api-types";

export type WateringPlantProfile = PlantProfileModel;
export type WateringPotProfile = PotProfileModel;
export type WateringClimateSummary = ClimateSummaryModel;
export type WateringPotMetrics = PotMetricsModel;
export type WateringOutputs = IrrigationOutputsModel;
export type WateringAssumptions = AssumptionsModel;
export type WateringDiagnostics = DiagnosticsModel;
export type WateringRequestSample = ClimateSampleModel;
export type WateringRequest = IrrigationRequest;
export type WateringRecommendation = IrrigationResponse;
export type LocalWeatherResponse = WeatherResponse;
export type LocalWeatherSample = WeatherTelemetry;
export type HrrrPointSnapshot = HrrrSnapshot;
export type HubWeatherLocationResponse = WeatherLocationResponse;
export type HubWeatherLocationUpsertRequest = WeatherLocationUpsertRequest;

export type WeatherStation = {
  id: string | null;
  name: string | null;
  identifier: string | null;
  lat: number | null;
  lon: number | null;
  distanceKm: number | null;
};

export type WeatherSeries = {
  samples: LocalWeatherSample[];
  coverageHours: number;
  availableWindows: number[];
  station: WeatherStation | null;
  sources: string[];
  blendMode: "station" | "station_hrrr_solar" | "hrrr";
  hrrrUsed: boolean;
  hrrrError: string | null;
};

export type WeatherLocation = {
  lat: number;
  lon: number;
  accuracyM: number | null;
  source: string;
  observedAt: string | null;
  updatedAt: string;
};

export type IrrigationEstimateRequest =
  paths["/api/v1/irrigation/estimate"]["post"]["requestBody"]["content"]["application/json"];
export type IrrigationEstimateResponse =
  paths["/api/v1/irrigation/estimate"]["post"]["responses"][200]["content"]["application/json"];
export type LocalWeatherEndpointRequestParams =
  paths["/api/v1/weather/local"]["get"]["parameters"]["query"];
export type LocalWeatherEndpointResponse =
  paths["/api/v1/weather/local"]["get"]["responses"][200]["content"]["application/json"];
export type WeatherLocationEndpointResponse =
  paths["/api/v1/weather/location"]["get"]["responses"][200]["content"]["application/json"];
export type WeatherLocationEndpointRequest =
  paths["/api/v1/weather/location"]["put"]["requestBody"]["content"]["application/json"];
export type HrrrPointRequestParams =
  paths["/api/v1/weather/hrrr/point"]["get"]["parameters"]["query"];
export type HrrrPointResponse =
  paths["/api/v1/weather/hrrr/point"]["get"]["responses"][200]["content"]["application/json"];

export interface LocalWeatherRequestParams {
  lat: number;
  lon: number;
  hours: number;
}

export interface WeatherLocationUpsertInput {
  lat: number;
  lon: number;
  accuracyM?: number | null;
  source?: string;
  observedAt?: string | null;
}

export interface WateringRequestOptions {
  potDiameterCm: number;
  potHeightCm?: number;
  cropCoefficient?: number;
  plantName?: string;
  lookbackHours?: number;
  availableWaterFraction?: number;
  irrigationEfficiency?: number;
  targetRefillFraction?: number;
  assumedWindSpeed?: number;
  netRadiationFactor?: number;
}

export type WateringTelemetrySample = Partial<ClimateSampleModel> & {
  timestamp?: string | null;
};

export const DEFAULT_WATERING_REQUEST_MAX_SAMPLES = 96;

export interface HubClientOptions {
  baseUrl: string;
  defaultHeaders?: HeadersInit;
  fetchImpl?: typeof fetch;
}

export interface HubRequestOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
}

export interface HubClient {
  fetchHrrrPoint(params: HrrrPointRequestParams, options?: HubRequestOptions): Promise<HrrrPointResponse>;
  fetchLocalWeather(params: LocalWeatherRequestParams, options?: HubRequestOptions): Promise<WeatherSeries>;
  fetchWeatherLocation(options?: HubRequestOptions): Promise<WeatherLocation | null>;
  fetchWateringRecommendation(
    payload: IrrigationEstimateRequest,
    options?: HubRequestOptions
  ): Promise<IrrigationEstimateResponse>;
  upsertWeatherLocation(payload: WeatherLocationUpsertInput, options?: HubRequestOptions): Promise<WeatherLocation>;
}

export function createHubClient(options: HubClientOptions): HubClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? resolveFetch();

  return {
    async fetchHrrrPoint(params, requestOptions) {
      const query = new URLSearchParams({
        lat: params.lat.toString(),
        lon: params.lon.toString(),
      });
      if (params.refresh !== undefined) {
        query.set("refresh", params.refresh ? "true" : "false");
      }
      if (params.persist !== undefined) {
        query.set("persist", params.persist ? "true" : "false");
      }
      return request<HrrrPointResponse>(fetchImpl, baseUrl, `/weather/hrrr/point?${query.toString()}`, {
        defaultHeaders: options.defaultHeaders,
        failureMessage: "Failed to load HRRR snapshot",
        headers: requestOptions?.headers,
        method: "GET",
        signal: requestOptions?.signal,
      });
    },
    async fetchLocalWeather(params, requestOptions) {
      const query = new URLSearchParams({
        lat: params.lat.toString(),
        lon: params.lon.toString(),
        hours: params.hours.toString(),
      });
      const payload = await request<LocalWeatherEndpointResponse>(
        fetchImpl,
        baseUrl,
        `/weather/local?${query.toString()}`,
        {
          defaultHeaders: options.defaultHeaders,
          failureMessage: "Failed to load local weather",
          headers: requestOptions?.headers,
          method: "GET",
          signal: requestOptions?.signal,
        }
      );
      return toWeatherSeries(payload);
    },
    async fetchWeatherLocation(requestOptions) {
      try {
        const payload = await request<WeatherLocationEndpointResponse>(fetchImpl, baseUrl, "/weather/location", {
          defaultHeaders: options.defaultHeaders,
          failureMessage: "Failed to load weather location",
          headers: requestOptions?.headers,
          method: "GET",
          signal: requestOptions?.signal,
        });
        return toWeatherLocation(payload);
      } catch (error) {
        if (isHubResponseError(error) && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    fetchWateringRecommendation(payload, requestOptions) {
      return request<IrrigationEstimateResponse>(fetchImpl, baseUrl, "/irrigation/estimate", {
        body: JSON.stringify(payload),
        defaultHeaders: options.defaultHeaders,
        failureMessage: "Failed to load watering recommendation",
        headers: requestOptions?.headers,
        method: "POST",
        signal: requestOptions?.signal,
      });
    },
    async upsertWeatherLocation(payload, requestOptions) {
      const body: WeatherLocationEndpointRequest = {
        lat: payload.lat,
        lon: payload.lon,
        accuracy_m: payload.accuracyM ?? null,
        source: payload.source ?? "browser_geolocation",
        observed_at: payload.observedAt ?? null,
      };
      const result = await request<WeatherLocationEndpointResponse>(fetchImpl, baseUrl, "/weather/location", {
        body: JSON.stringify(body),
        defaultHeaders: options.defaultHeaders,
        failureMessage: "Failed to sync weather location",
        headers: requestOptions?.headers,
        method: "PUT",
        signal: requestOptions?.signal,
      });
      return toWeatherLocation(result);
    },
  };
}

interface RequestOptions {
  body?: BodyInit | null;
  defaultHeaders?: HeadersInit;
  failureMessage?: string;
  headers?: HeadersInit;
  method: string;
  signal?: AbortSignal;
}

export class HubResponseError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HubResponseError";
    this.status = status;
  }
}

async function request<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  options: RequestOptions
): Promise<T> {
  const headers = mergeHeaders(options.defaultHeaders, options.headers);
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetchImpl(buildUrl(baseUrl, path), {
    body: options.body ?? null,
    headers,
    method: options.method,
    signal: options.signal,
  });

  if (!response.ok) {
    let message = `${options.failureMessage ?? "Hub API request failed"} (${response.status})`;
    try {
      const payload = (await response.json()) as { detail?: unknown };
      if (typeof payload.detail === "string" && payload.detail.trim()) {
        message = payload.detail;
      }
    } catch {
      // Use the status-based fallback if the response body is unavailable.
    }
    throw new HubResponseError(message, response.status);
  }

  return (await response.json()) as T;
}

export function buildWateringRecommendationRequest(
  samples: WateringTelemetrySample[],
  options: WateringRequestOptions,
  maxSamples = DEFAULT_WATERING_REQUEST_MAX_SAMPLES
): WateringRequest {
  const {
    potDiameterCm,
    potHeightCm,
    cropCoefficient = 0.85,
    plantName = "Indoor Pot",
    lookbackHours = 24,
    availableWaterFraction = 0.35,
    irrigationEfficiency = 0.9,
    targetRefillFraction = 0.45,
    assumedWindSpeed = 0.1,
    netRadiationFactor = 0.75,
  } = options;

  const normalizedHeight = potHeightCm ?? Math.max(potDiameterCm * 0.85, 10);
  const trimmed = samples.length > maxSamples ? samples.slice(samples.length - maxSamples) : samples.slice();

  return {
    method: "penman_monteith",
    lookback_hours: lookbackHours,
    assumed_wind_speed_m_s: assumedWindSpeed,
    net_radiation_factor: netRadiationFactor,
    samples: trimmed
      .filter((sample) => Boolean(sample.timestamp))
      .map((sample) => ({
        timestamp: sample.timestamp ?? "",
        temperature_c: sample.temperature_c ?? null,
        humidity_pct: sample.humidity_pct ?? null,
        pressure_hpa: sample.pressure_hpa ?? null,
        solar_radiation_w_m2: sample.solar_radiation_w_m2 ?? null,
        wind_speed_m_s: sample.wind_speed_m_s ?? null,
      })),
    plant: {
      name: plantName,
      crop_coefficient: cropCoefficient,
    },
    pot: {
      diameter_cm: potDiameterCm,
      height_cm: normalizedHeight,
      available_water_fraction: availableWaterFraction,
      irrigation_efficiency: irrigationEfficiency,
      target_refill_fraction: targetRefillFraction,
    },
  };
}

export function toWeatherSeries(payload: LocalWeatherEndpointResponse): WeatherSeries {
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
    blendMode: payload.blend_mode ?? "station",
    hrrrUsed: Boolean(payload.hrrr_used),
    hrrrError: payload.hrrr_error ?? null,
  };
}

export function toWeatherLocation(payload: WeatherLocationEndpointResponse): WeatherLocation {
  return {
    lat: payload.lat,
    lon: payload.lon,
    accuracyM: payload.accuracy_m ?? null,
    source: payload.source ?? "unknown",
    observedAt: payload.observed_at ?? null,
    updatedAt: payload.updated_at,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("baseUrl is required for HubClient");
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function buildUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function mergeHeaders(defaultHeaders?: HeadersInit, headers?: HeadersInit): Headers {
  const merged = new Headers(defaultHeaders);
  if (headers) {
    new Headers(headers).forEach((value, key) => {
      merged.set(key, value);
    });
  }
  return merged;
}

function resolveFetch(): typeof fetch {
  if (typeof fetch === "function") {
    return fetch.bind(globalThis);
  }
  throw new Error("fetch is not available in the current environment");
}

function isHubResponseError(error: unknown): error is HubResponseError {
  return error instanceof HubResponseError;
}
