import { describe, expect, it, vi } from "vitest";

import {
  buildWateringRecommendationRequest,
  createHubClient,
  type LocalWeatherEndpointResponse,
  type WateringRequest,
} from "../src/client/hubClient";

describe("hub client", () => {
  it("loads local weather and maps station fields for UI compatibility", async () => {
    const responsePayload: LocalWeatherEndpointResponse = {
      available_windows: [6, 12, 24],
      blend_mode: "station_hrrr_solar",
      coverage_hours: 24,
      data: [
        {
          timestamp: "2026-04-25T12:00:00.000Z",
          temperature_c: 22,
          humidity_pct: 55,
          pressure_hpa: 1012,
          solar_radiation_w_m2: 420,
          wind_speed_m_s: 0.4,
        },
      ],
      hrrr_error: null,
      hrrr_used: true,
      location: { lat: 40.1, lon: -75.2 },
      requested_hours: 24,
      sources: [" station ", "", "hrrr"],
      station: {
        distance_km: 3.2,
        id: "station-1",
        identifier: "KABC",
        lat: 40.2,
        lon: -75.3,
        name: "Station 1",
      },
    };
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue(responsePayload),
    } as unknown as Response);

    const client = createHubClient({
      baseUrl: "https://hub.example.test/api/v1/",
      fetchImpl: fetchMock,
    });

    const result = await client.fetchLocalWeather({ lat: 40.1, lon: -75.2, hours: 24 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/weather/local?lat=40.1&lon=-75.2&hours=24",
      expect.objectContaining({ method: "GET" })
    );
    expect(result.station?.distanceKm).toBe(3.2);
    expect(result.sources).toEqual(["station", "hrrr"]);
    expect(result.samples).toEqual(responsePayload.data);
  });

  it("loads and upserts weather location using generated request shapes", async () => {
    const locationPayload = {
      accuracy_m: 12,
      lat: 40.1,
      lon: -75.2,
      observed_at: "2026-04-25T12:00:00.000Z",
      source: "browser_geolocation",
      updated_at: "2026-04-25T12:01:00.000Z",
    };
    const fetchMock = vi
      .fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockResolvedValue(locationPayload),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockResolvedValue(locationPayload),
      } as unknown as Response);

    const client = createHubClient({
      baseUrl: "https://hub.example.test/api/v1",
      fetchImpl: fetchMock,
    });

    await expect(client.fetchWeatherLocation()).resolves.toEqual({
      accuracyM: 12,
      lat: 40.1,
      lon: -75.2,
      observedAt: "2026-04-25T12:00:00.000Z",
      source: "browser_geolocation",
      updatedAt: "2026-04-25T12:01:00.000Z",
    });

    await client.upsertWeatherLocation({
      accuracyM: 12,
      lat: 40.1,
      lon: -75.2,
      observedAt: "2026-04-25T12:00:00.000Z",
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://hub.example.test/api/v1/weather/location",
      expect.objectContaining({ method: "PUT" })
    );
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      accuracy_m: 12,
      lat: 40.1,
      lon: -75.2,
      observed_at: "2026-04-25T12:00:00.000Z",
      source: "browser_geolocation",
    });
  });

  it("returns null when no weather location is configured", async () => {
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: vi.fn().mockResolvedValue({ detail: "No weather location configured" }),
    } as unknown as Response);

    const client = createHubClient({
      baseUrl: "https://hub.example.test/api/v1",
      fetchImpl: fetchMock,
    });

    await expect(client.fetchWeatherLocation()).resolves.toBeNull();
  });

  it("loads HRRR point snapshots with refresh and persist query parameters", async () => {
    const responsePayload = {
      fields: {},
      location: { lat: 40.1, lon: -75.2 },
      metadata: {},
      persisted: true,
      run: {
        cycle: "2026042512",
        forecast_hour: 1,
        valid_time: "2026-04-25T13:00:00.000Z",
      },
      source: "hrrr",
    };
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue(responsePayload),
    } as unknown as Response);

    const client = createHubClient({
      baseUrl: "https://hub.example.test/api/v1",
      fetchImpl: fetchMock,
    });

    await expect(
      client.fetchHrrrPoint({ lat: 40.1, lon: -75.2, refresh: true, persist: false })
    ).resolves.toEqual(responsePayload);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/weather/hrrr/point?lat=40.1&lon=-75.2&refresh=true&persist=false",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("posts irrigation estimate requests with generated contract types", async () => {
    const payload: WateringRequest = {
      method: "penman_monteith",
      samples: [
        {
          timestamp: "2026-04-25T12:00:00.000Z",
          temperature_c: 22,
          humidity_pct: 55,
          pressure_hpa: 1012,
          solar_radiation_w_m2: 420,
          wind_speed_m_s: null,
        },
      ],
      pot: {
        diameter_cm: 18,
        height_cm: 22,
        available_water_fraction: 0.35,
        irrigation_efficiency: 0.9,
        target_refill_fraction: 0.4,
      },
    };
    const responsePayload = {
      method: "penman_monteith",
      assumptions: {
        assumed_wind_speed_m_s: 0.1,
        lookback_hours: 24,
        net_radiation_factor: 0.75,
      },
      climate: {
        avg_humidity_pct: 55,
        avg_pressure_hpa: 1012,
        avg_solar_w_m2: 420,
        avg_temperature_c: 22,
        coverage_hours: 1,
        data_points: 1,
        net_radiation_mj_m2_day: 6,
        wind_speed_m_s: 0.1,
      },
      diagnostics: { notes: [] },
      outputs: {
        adjusted_daily_liters: 0.12,
        daily_water_liters: 0.1,
        etc_mm_day: 3,
        et0_mm_day: 3.5,
        recommended_events_per_day: 1,
        recommended_ml_per_day: 120,
        recommended_ml_per_event: 120,
      },
      plant: {
        crop_coefficient: 0.85,
        name: null,
      },
      pot: payload.pot,
      pot_metrics: {
        available_water_liters: 0.9,
        max_event_liters: 0.36,
        surface_area_m2: 0.025,
        volume_liters: 5.6,
      },
    };
    const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: vi.fn().mockResolvedValue(responsePayload),
    } as unknown as Response);

    const client = createHubClient({
      baseUrl: "https://hub.example.test/api/v1/",
      defaultHeaders: { Authorization: "Bearer token" },
      fetchImpl: fetchMock,
    });

    const result = await client.fetchWateringRecommendation(payload, {
      headers: { "X-User-Id": "user-1" },
    });

    expect(result).toEqual(responsePayload);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/irrigation/estimate",
      expect.objectContaining({
        body: JSON.stringify(payload),
        method: "POST",
      })
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token");
    expect(new Headers(init.headers).get("X-User-Id")).toBe("user-1");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("builds irrigation estimate requests from telemetry without UI-owned payload assembly", () => {
    const payload = buildWateringRecommendationRequest(
      [
        {
          timestamp: "",
          temperature_c: 19,
        },
        {
          timestamp: "2026-04-25T12:00:00.000Z",
          temperature_c: 22,
          humidity_pct: 55,
          pressure_hpa: 1012,
          solar_radiation_w_m2: 420,
          wind_speed_m_s: undefined,
        },
      ],
      {
        cropCoefficient: 0.7,
        plantName: "Basil",
        potDiameterCm: 20,
      }
    );

    expect(payload).toMatchObject({
      assumed_wind_speed_m_s: 0.1,
      lookback_hours: 24,
      method: "penman_monteith",
      net_radiation_factor: 0.75,
      plant: {
        crop_coefficient: 0.7,
        name: "Basil",
      },
      pot: {
        available_water_fraction: 0.35,
        diameter_cm: 20,
        height_cm: 17,
        irrigation_efficiency: 0.9,
        target_refill_fraction: 0.45,
      },
      samples: [
        {
          humidity_pct: 55,
          pressure_hpa: 1012,
          solar_radiation_w_m2: 420,
          temperature_c: 22,
          timestamp: "2026-04-25T12:00:00.000Z",
          wind_speed_m_s: null,
        },
      ],
    });
  });
});
