import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, vi } from "vitest";
import App from "./App";
import * as hubClient from "./api/hubClient";
import type {
  HealthSummary,
  MqttHealth,
  SensorReadResponse,
  StorageHealth,
  WateringRecommendation,
  WeatherCacheHealth,
} from "./api/hubClient";

const mockWateringRecommendation: WateringRecommendation = {
  method: "penman_monteith",
  climate: {
    coverage_hours: 2,
    data_points: 12,
    avg_temperature_c: 22.4,
    avg_humidity_pct: 54.2,
    avg_pressure_hpa: 1011.3,
    avg_solar_w_m2: 420,
    wind_speed_m_s: 0.12,
    net_radiation_mj_m2_day: 2.8,
  },
  plant: {
    name: "Mock Plant",
    crop_coefficient: 0.9,
  },
  pot: {
    diameter_cm: 26,
    height_cm: 24,
    available_water_fraction: 0.4,
    irrigation_efficiency: 0.9,
    target_refill_fraction: 0.5,
  },
  pot_metrics: {
    surface_area_m2: 0.21,
    volume_liters: 7.5,
    available_water_liters: 2.1,
    max_event_liters: 0.45,
  },
  outputs: {
    et0_mm_day: 4.2,
    etc_mm_day: 3.8,
    daily_water_liters: 1.2,
    adjusted_daily_liters: 1.0,
    recommended_events_per_day: 2.0,
    recommended_ml_per_event: 480,
    recommended_ml_per_day: 960,
  },
  assumptions: {
    lookback_hours: 24,
    assumed_wind_speed_m_s: 0.15,
    net_radiation_factor: 0.75,
  },
  diagnostics: {
    notes: [],
  },
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setViewportMatches(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function installMockEventSource() {
  const instances: Array<{ url: string; close: ReturnType<typeof vi.fn> }> = [];
  class MockEventSource {
    url: string;
    close = vi.fn();

    constructor(url: string) {
      this.url = url;
      instances.push({ url, close: this.close });
    }

    addEventListener = vi.fn();
    removeEventListener = vi.fn();
  }

  vi.stubGlobal("EventSource", MockEventSource);
  return instances;
}

describe("App", () => {
  let fetchPotTelemetryMock: ReturnType<typeof vi.spyOn>;
  const settingsStorageKey = "projectplant:ui:settings";
  const mockInfo = {
    name: "ProjectPlant Hub",
    version: "0.1.0",
    debug: true,
    cors_origins: ["http://localhost:5173"],
    mqtt_enabled: true,
    mqtt_host: "localhost",
    mqtt_port: 1883,
    pot_telemetry_retention_hours: 168,
    pot_telemetry_max_rows: 200_000,
  };
  const mockHealthSummary: HealthSummary = {
    status: "ok",
    version: "0.1.0",
    uptime: {
      started_at: "2026-03-15T00:00:00Z",
      seconds: 3600,
    },
    database: {
      status: "ok",
      path: "data/pot_telemetry.sqlite",
      exists: true,
      size_bytes: 4096,
      latency_ms: 1.2,
      error: null,
    },
  };
  const mockMqttHealth: MqttHealth = {
    enabled: true,
    status: "ok",
    connection: {
      connected: true,
      reconnecting: false,
      host: "localhost",
      port: 1883,
      client_id: "projectplant-hub",
      last_connect_time: "2026-03-15T00:00:00Z",
      last_disconnect_time: null,
      last_disconnect_reason: null,
    },
    heartbeat: {
      status: "ok",
      count: 1,
      latest_received_at: "2026-03-15T00:05:00Z",
      pots: [],
    },
  };
  const mockWeatherHealth: WeatherCacheHealth = {
    status: "ok",
    cache_dir: "data/hrrr/cache",
    file_count: 3,
    bytes: 2048,
    latest_modified: "2026-03-15T00:05:00Z",
    oldest_modified: "2026-03-15T00:00:00Z",
    age_seconds: 60,
    state: "fresh",
    db_path: "data/hrrr/solar_history.sqlite",
    row_count: 3,
    retention_hours: 72,
    newest_valid_time: "2026-03-15T00:05:00Z",
    oldest_valid_time: "2026-03-15T00:00:00Z",
  };
  const mockStorageHealth: StorageHealth = {
    status: "ok",
    path_checked: "data",
    total_bytes: 100_000,
    used_bytes: 25_000,
    free_bytes: 75_000,
    used_percent: 25,
    free_percent: 75,
  };

  const mockTelemetry = [
    {
      timestamp: new Date().toISOString(),
      temperature_c: 21.5,
      humidity_pct: 55.2,
      pressure_hpa: 1010.5,
      solar_radiation_w_m2: 450,
      wind_speed_m_s: 1.75,
      station: "sensor-1",
      source: "sensor",
    },
  ];

  beforeEach(() => {
    setViewportMatches(false);
    window.localStorage.clear();
    window.localStorage.setItem(settingsStorageKey, JSON.stringify({ mode: "live" }));
    vi.spyOn(hubClient, "fetchHubInfo").mockResolvedValue(mockInfo);
    vi.spyOn(hubClient, "fetchMockTelemetry").mockResolvedValue(mockTelemetry);
    vi.spyOn(hubClient, "fetchLiveTelemetry").mockResolvedValue(mockTelemetry);
    vi.spyOn(hubClient, "fetchHealthSummary").mockResolvedValue(mockHealthSummary);
    vi.spyOn(hubClient, "fetchMqttHealth").mockResolvedValue(mockMqttHealth);
    vi.spyOn(hubClient, "fetchWeatherCacheHealth").mockResolvedValue(mockWeatherHealth);
    vi.spyOn(hubClient, "fetchStorageHealth").mockResolvedValue(mockStorageHealth);
    vi.spyOn(hubClient, "fetchHealthEvents").mockResolvedValue({ count: 0, events: [] });
    vi.spyOn(hubClient, "fetchWeatherLocation").mockResolvedValue(null);
    vi.spyOn(hubClient, "upsertWeatherLocation").mockResolvedValue({
      lat: 38.9,
      lon: -77.0,
      accuracyM: 10,
      source: "browser_geolocation",
      observedAt: "2026-03-17T22:00:00Z",
      updatedAt: "2026-03-17T22:00:01Z",
    });
    fetchPotTelemetryMock = vi.spyOn(hubClient, "fetchPotTelemetry").mockResolvedValue([]);
    vi.spyOn(hubClient, "fetchLocalWeather").mockResolvedValue({
      samples: mockTelemetry,
      coverageHours: 1.5,
      availableWindows: [0.5, 1, 2],
      sources: ["noaa_nws"],
      blendMode: "station",
      hrrrUsed: false,
      hrrrError: null,
      station: {
        id: "https://api.weather.gov/stations/KXYZ",
        name: "Mock Station",
        identifier: "KXYZ",
        lat: 38.85,
        lon: -77.04,
        distanceKm: 4.2,
      },
    });
    vi.spyOn(hubClient, "fetchWateringRecommendation").mockResolvedValue(mockWateringRecommendation);
    vi.spyOn(hubClient, "fetchPlantControlSchedule").mockImplementation(async (potId: string) => ({
      potId: potId.trim().toLowerCase(),
      light: { enabled: false, startTime: "06:00", endTime: "20:00" },
      pump: { enabled: false, startTime: "07:00", endTime: "07:15" },
      icZone1: { enabled: false, startTime: "07:00", endTime: "07:15" },
      mister: { enabled: false, startTime: "08:00", endTime: "08:15" },
      fan: { enabled: false, startTime: "09:00", endTime: "18:00" },
      updatedAt: "2026-02-11T00:00:00Z",
    }));
    vi.spyOn(hubClient, "updatePlantControlSchedule").mockImplementation(async (potId: string, payload) => ({
      potId: potId.trim().toLowerCase(),
      light: { ...payload.light },
      pump: { ...payload.pump },
      icZone1: { ...payload.icZone1 },
      mister: { ...payload.mister },
      fan: { ...payload.fan },
      updatedAt: "2026-02-11T00:05:00Z",
    }));

    const coords: GeolocationCoordinates = {
      latitude: 38.9,
      longitude: -77.0,
      accuracy: 10,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({
        latitude: 38.9,
        longitude: -77.0,
        accuracy: 10,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      }),
    };
    const timestamp = Date.now();
    const mockPosition: GeolocationPosition = {
      coords,
      timestamp,
      toJSON: () => ({ coords, timestamp }),
    };

    Object.defineProperty(window.navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: vi.fn((success) => success(mockPosition)),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders plant and local condition tabs", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText(/projectplant hub/i)).toBeInTheDocument());

    expect(screen.getByText(/0\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText(/broker localhost:1883/i)).toBeInTheDocument();

    const [plantTab] = screen.getAllByRole("button", { name: /plant conditions/i });
    const [localTab] = screen.getAllByRole("button", { name: /local area conditions/i });
    expect(plantTab).toBeInTheDocument();
    expect(localTab).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: /plant conditions/i })).toBeInTheDocument();

    await userEvent.click(localTab);
    await userEvent.click(screen.getByRole("button", { name: /grant location access/i }));

    await waitFor(() => expect(hubClient.fetchLocalWeather).toHaveBeenCalled());
    await waitFor(() => expect(hubClient.upsertWeatherLocation).toHaveBeenCalled());
    expect(await screen.findByRole("heading", { name: /local area conditions/i })).toBeInTheDocument();
    expect(await screen.findByText("Wind Speed: 1.75 m/s")).toBeInTheDocument();
  });

  it("uses the hub weather location when browser geolocation is unavailable", async () => {
    Object.defineProperty(window.navigator, "geolocation", {
      configurable: true,
      value: undefined,
    });
    vi.spyOn(hubClient, "fetchWeatherLocation").mockResolvedValue({
      lat: 38.944184,
      lon: -77.062402,
      accuracyM: 42,
      source: "browser_geolocation",
      observedAt: "2026-03-17T22:00:00Z",
      updatedAt: "2026-03-17T22:00:01Z",
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/projectplant hub/i)).toBeInTheDocument());

    const [localTab] = screen.getAllByRole("button", { name: /local area conditions/i });
    await userEvent.click(localTab);

    await waitFor(() =>
      expect(hubClient.fetchLocalWeather).toHaveBeenCalledWith(
        { lat: 38.944184, lon: -77.062402, hours: 6 },
        expect.anything()
      )
    );
    expect(await screen.findByText(/last synced location/i)).toBeInTheDocument();
  });

  it("does not request an event token without auth context in live mode", async () => {
    const fetchEventTokenMock = vi.spyOn(hubClient, "fetchEventToken").mockResolvedValue({
      access_token: "event-token",
      token_type: "bearer",
      expires_in: 3600,
    });

    render(<App />);

    await waitFor(() => {
      expect(hubClient.fetchHubInfo).toHaveBeenCalled();
    });

    expect(fetchEventTokenMock).not.toHaveBeenCalled();
  });

  it("requests an event token when local-compat mode has an active user", async () => {
    window.localStorage.setItem(
      settingsStorageKey,
      JSON.stringify({
        mode: "live",
        authMode: "local_compat",
        activeUserId: "user-demo-owner",
      })
    );
    const eventSources = installMockEventSource();
    const fetchEventTokenMock = vi.spyOn(hubClient, "fetchEventToken").mockResolvedValue({
      access_token: "event-token",
      token_type: "bearer",
      expires_in: 3600,
    });

    render(<App />);

    await waitFor(() => {
      expect(fetchEventTokenMock).toHaveBeenCalledTimes(1);
    });

    expect(eventSources).toHaveLength(1);
    expect(eventSources[0]?.url).toContain("/api/v1/events/stream?token=event-token");
  });

  it("renders the dashboard in demo mode without bootstrapping the hub", async () => {
    window.localStorage.setItem(settingsStorageKey, JSON.stringify({ mode: "demo" }));
    const fetchHubInfoSpy = vi.mocked(hubClient.fetchHubInfo);
    fetchHubInfoSpy.mockClear();

    render(<App />);

    await waitFor(() => expect(screen.getByText(/projectplant hub/i)).toBeInTheDocument());

    expect(screen.getByText(/demo mode is active/i)).toBeInTheDocument();
    expect(screen.getByText(/preview the dashboard with demo telemetry/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /plant control/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /local area conditions/i })).toBeDisabled();
    expect(fetchHubInfoSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/demo telemetry generated for preview mode/i)).toBeInTheDocument();
  });

  it("shows a connection error in live mode when the hub bootstrap fails", async () => {
    vi.spyOn(hubClient, "fetchHubInfo").mockRejectedValueOnce(new Error("Hub offline"));

    render(<App />);

    expect(await screen.findByRole("heading", { name: /unable to reach the hub/i })).toBeInTheDocument();
    expect(screen.getByText(/hub offline/i)).toBeInTheDocument();
    expect(screen.getByText(/current api target/i)).toBeInTheDocument();
  });

  it("requests sensor snapshot and renders metrics", async () => {
    const response: SensorReadResponse = {
      payload: {
        potId: "pot-55",
        moisture: 55.5,
        temperature: 22.7,
        humidity: 48.0,
        flowRateLpm: 0.123,
        valveOpen: false,
        waterLow: true,
        waterCutoff: false,
        soilRaw: 1023,
        timestamp: "2025-10-14T12:34:56.000Z",
        timestampMs: Date.parse("2025-10-14T12:34:56.000Z"),
      },
      requestId: "req-42",
    };
    fetchPotTelemetryMock.mockResolvedValue([
      {
        timestamp: response.payload.timestamp,
        temperature_c: response.payload.temperature,
        humidity_pct: response.payload.humidity,
        pressure_hpa: null,
        solar_radiation_w_m2: null,
        moisture_pct: response.payload.moisture,
        wind_speed_m_s: null,
        station: "pot-55",
        source: "test",
      },
    ]);
    const deferred = createDeferred<SensorReadResponse>();
    const requestSensorReadMock = vi.spyOn(hubClient, "requestSensorRead").mockReturnValueOnce(deferred.promise);

    render(<App />);
    await waitFor(() => expect(screen.getByText(/projectplant hub/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /plant control/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /manual controls/i })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /penman-monteith equation/i })).toBeInTheDocument();

    const controlPotSelect = screen.getByLabelText(/control pot/i);
    await userEvent.selectOptions(controlPotSelect, "__custom__");
    const input = await screen.findByLabelText(/custom pot id/i);
    await userEvent.type(input, " pot-55 ");

    const submitButton = screen.getByRole("button", { name: /sensor read/i });
    expect(submitButton).not.toBeDisabled();

    await userEvent.click(submitButton);
    await waitFor(() => expect(submitButton).toBeDisabled());
    expect(screen.getByText(/requesting/i)).toBeInTheDocument();

    deferred.resolve(response);

    await waitFor(() => expect(submitButton).not.toBeDisabled());
    await waitFor(() => expect(requestSensorReadMock).toHaveBeenCalledTimes(1));
    expect(requestSensorReadMock).toHaveBeenCalledWith(
      "pot-55",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    expect(await screen.findByText(/snapshot captured/i)).toBeInTheDocument();
    expect(screen.getByText("55.5 %")).toBeInTheDocument();
    expect(screen.getByText("22.7 deg C")).toBeInTheDocument();
    expect(screen.getByText("48.0 %")).toBeInTheDocument();
    expect(screen.getByText("0.12 L/min")).toBeInTheDocument();
    expect(screen.getByText(/Request req-42 - Pot pot-55/i)).toBeInTheDocument();
    expect(screen.getByText(/Pot pot-55/)).toBeInTheDocument();
    expect(screen.getByText(/Reservoir low/)).toBeInTheDocument();
    expect(screen.getByText(/Cutoff OK/)).toBeInTheDocument();

    await waitFor(() =>
      expect(fetchPotTelemetryMock).toHaveBeenCalledWith(
        "pot-55",
        expect.objectContaining({ hours: 24, limit: 86_400 }),
        expect.any(AbortSignal)
      )
    );

    await userEvent.click(screen.getByRole("button", { name: /plant conditions/i }));
    const seriesSelect = await screen.findByLabelText(/Series/i);
    expect(seriesSelect).toHaveValue("pot-55");
    const rangeSelect = await screen.findByLabelText(/^Range$/i);
    expect(rangeSelect).toHaveValue("1d");
    const initialRangeBadges = await screen.findAllByText(/Last 24 hours/i);
    expect(initialRangeBadges.length).toBeGreaterThan(0);
    const telemetryTable = await screen.findByRole("table");
    expect(within(telemetryTable).getByText("55.5")).toBeInTheDocument();
    expect(within(telemetryTable).getByText("22.7")).toBeInTheDocument();

    const initialFetchCount = fetchPotTelemetryMock.mock.calls.length;
    await userEvent.selectOptions(rangeSelect, "5m");
    await waitFor(() => expect(fetchPotTelemetryMock.mock.calls.length).toBeGreaterThan(initialFetchCount));
    const lastCall = fetchPotTelemetryMock.mock.calls[fetchPotTelemetryMock.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe("pot-55");
    expect(lastCall?.[1]).toMatchObject({ hours: 5 / 60, limit: 300 });
    expect(lastCall?.[2]).toBeInstanceOf(AbortSignal);
    const updatedRangeBadges = await screen.findAllByText(/Last 5 minutes/i);
    expect(updatedRangeBadges.length).toBeGreaterThan(0);
  });

  it("shows error feedback when sensor read fails", async () => {
    const requestSensorReadMock = vi
      .spyOn(hubClient, "requestSensorRead")
      .mockRejectedValueOnce(new Error("Timed out waiting for sensor reading"));

    render(<App />);
    await waitFor(() => expect(screen.getByText(/projectplant hub/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /plant control/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /manual controls/i })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /penman-monteith equation/i })).toBeInTheDocument();

    const controlPotSelect = screen.getByLabelText(/control pot/i);
    await userEvent.selectOptions(controlPotSelect, "__custom__");
    const input = await screen.findByLabelText(/custom pot id/i);
    await userEvent.clear(input);
    await userEvent.type(input, " pot-88 ");

    const submitButton = screen.getByRole("button", { name: /sensor read/i });
    await userEvent.click(submitButton);

    await waitFor(() => expect(requestSensorReadMock).toHaveBeenCalledWith("pot-88", expect.anything()));
    expect(await screen.findByText("Timed out waiting for sensor reading")).toBeInTheDocument();
    expect(screen.getByText(/No on-demand snapshot yet/i)).toBeInTheDocument();
    await waitFor(() => expect(submitButton).not.toBeDisabled());
  });

  it("renders the mobile bottom navigation on narrow viewports", async () => {
    setViewportMatches(true);

    render(<App />);
    await waitFor(() => expect(screen.getByText(/projectplant hub/i)).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /controls/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /plants/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /diagnostics/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /setup/i })).toBeInTheDocument();
  });
});


