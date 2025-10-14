import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, vi } from "vitest";
import App from "./App";
import * as hubClient from "./api/hubClient";
import type { SensorReadResponse, WateringRecommendation } from "./api/hubClient";

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

describe("App", () => {
  const mockInfo = {
    name: "ProjectPlant Hub",
    version: "0.1.0",
    debug: true,
    cors_origins: ["http://localhost:5173"],
    mqtt_enabled: true,
    mqtt_host: "localhost",
    mqtt_port: 1883,
  };

  const mockTelemetry = [
    {
      timestamp: new Date().toISOString(),
      temperature_c: 21.5,
      humidity_pct: 55.2,
      pressure_hpa: 1010.5,
      solar_radiation_w_m2: 450,
      station: "sensor-1",
    },
  ];

  beforeEach(() => {
    vi.spyOn(hubClient, "fetchHubInfo").mockResolvedValue(mockInfo);
    vi.spyOn(hubClient, "fetchMockTelemetry").mockResolvedValue(mockTelemetry);
    vi.spyOn(hubClient, "fetchLocalWeather").mockResolvedValue({
      samples: mockTelemetry,
      coverageHours: 1.5,
      availableWindows: [0.5, 1, 2],
    });
    vi.spyOn(hubClient, "fetchWateringRecommendation").mockResolvedValue(mockWateringRecommendation);

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
  });

  it("renders plant and local condition tabs", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText(/projectplant hub/i)).toBeInTheDocument());

    expect(screen.getByText(/0\.1\.0/)).toBeInTheDocument();
    expect(screen.getByText(/broker localhost:1883/i)).toBeInTheDocument();

    const plantTab = screen.getByRole("button", { name: /plant conditions/i });
    const localTab = screen.getByRole("button", { name: /local area conditions/i });
    expect(plantTab).toBeInTheDocument();
    expect(localTab).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: /plant conditions/i })).toBeInTheDocument();

    await userEvent.click(localTab);
    await userEvent.click(screen.getByRole("button", { name: /grant location access/i }));

    await waitFor(() => expect(hubClient.fetchLocalWeather).toHaveBeenCalled());
    expect(await screen.findByRole("heading", { name: /local area conditions/i })).toBeInTheDocument();
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
    const deferred = createDeferred<SensorReadResponse>();
    const requestSensorReadMock = vi.spyOn(hubClient, "requestSensorRead").mockReturnValueOnce(deferred.promise);

    render(<App />);
    await waitFor(() => expect(screen.getByText(/projectplant hub/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /plant control/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /manual controls/i })).toBeInTheDocument());

    const input = screen.getByLabelText(/pot id/i);
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
    expect(screen.getByText(/Request req-42/)).toBeInTheDocument();
    expect(screen.getByText(/Pot pot-55/)).toBeInTheDocument();
    expect(screen.getByText(/Reservoir low/)).toBeInTheDocument();
    expect(screen.getByText(/Cutoff OK/)).toBeInTheDocument();
  });

  it("shows error feedback when sensor read fails", async () => {
    const requestSensorReadMock = vi
      .spyOn(hubClient, "requestSensorRead")
      .mockRejectedValueOnce(new Error("Timed out waiting for sensor reading"));

    render(<App />);
    await waitFor(() => expect(screen.getByText(/projectplant hub/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /plant control/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /manual controls/i })).toBeInTheDocument());

    const input = screen.getByLabelText(/pot id/i);
    await userEvent.type(input, " pot-88 ");

    const submitButton = screen.getByRole("button", { name: /sensor read/i });
    await userEvent.click(submitButton);

    await waitFor(() => expect(requestSensorReadMock).toHaveBeenCalledWith("pot-88", expect.anything()));
    expect(await screen.findByText("Timed out waiting for sensor reading")).toBeInTheDocument();
    expect(screen.getByText(/No on-demand snapshot yet/i)).toBeInTheDocument();
    await waitFor(() => expect(submitButton).not.toBeDisabled());
  });
});


