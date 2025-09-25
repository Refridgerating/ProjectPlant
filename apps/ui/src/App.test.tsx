import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, vi } from "vitest";
import App from "./App";
import * as hubClient from "./api/hubClient";

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
});


