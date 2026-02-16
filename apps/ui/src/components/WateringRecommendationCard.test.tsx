import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as hubClient from "../api/hubClient";
import type { PlantControlSchedule, PlantControlScheduleUpdate, WateringRecommendation } from "../api/hubClient";
import { WateringRecommendationCard } from "./WateringRecommendationCard";

const mockRecommendation: WateringRecommendation = {
  method: "penman_monteith",
  climate: {
    coverage_hours: 24,
    data_points: 96,
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

function normalizePotId(value: string): string {
  return value.trim().toLowerCase();
}

function baseSchedule(potId: string): PlantControlSchedule {
  return {
    potId,
    light: { enabled: false, startTime: "06:00", endTime: "20:00" },
    pump: { enabled: false, startTime: "07:00", endTime: "07:15" },
    mister: { enabled: false, startTime: "08:00", endTime: "08:15" },
    fan: { enabled: false, startTime: "09:00", endTime: "18:00" },
    updatedAt: "2026-02-11T00:00:00Z",
  };
}

function cloneSchedule(schedule: PlantControlSchedule): PlantControlSchedule {
  return JSON.parse(JSON.stringify(schedule)) as PlantControlSchedule;
}

let scheduleStore: Map<string, PlantControlSchedule>;

beforeEach(() => {
  scheduleStore = new Map<string, PlantControlSchedule>();
  vi.spyOn(hubClient, "fetchPlantControlSchedule").mockImplementation(async (potId: string) => {
    const normalized = normalizePotId(potId);
    const stored = scheduleStore.get(normalized) ?? baseSchedule(normalized);
    return cloneSchedule(stored);
  });
  vi.spyOn(hubClient, "updatePlantControlSchedule").mockImplementation(
    async (potId: string, payload: PlantControlScheduleUpdate) => {
      const normalized = normalizePotId(potId);
      const next: PlantControlSchedule = {
        potId: normalized,
        light: { ...payload.light },
        pump: { ...payload.pump },
        mister: { ...payload.mister },
        fan: { ...payload.fan },
        updatedAt: "2026-02-11T00:05:00Z",
      };
      scheduleStore.set(normalized, cloneSchedule(next));
      return cloneSchedule(next);
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("shows Plant Schedule and timer controls even without recommendation data", async () => {
  render(
    <WateringRecommendationCard
      recommendation={null}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      potId="pot-1"
      potLabel="Kitchen Basil"
    />
  );
  await waitFor(() => expect(hubClient.fetchPlantControlSchedule).toHaveBeenCalledWith("pot-1", expect.anything()));

  expect(screen.getByRole("heading", { name: /plant schedule/i })).toBeInTheDocument();
  expect(screen.getByText(/No watering recommendation yet/i)).toBeInTheDocument();
  expect(screen.getByText(/Managing schedule for Kitchen Basil/i)).toBeInTheDocument();
  expect(screen.getByText(/Device Timers/i)).toBeInTheDocument();
  expect(screen.getByText("Lights")).toBeInTheDocument();
  expect(screen.getByText("Pumps")).toBeInTheDocument();
  expect(screen.getByText("Mister")).toBeInTheDocument();
  expect(screen.getByText("Fans")).toBeInTheDocument();
  const saveButton = screen.getByRole("button", { name: /save timer changes/i });
  expect(saveButton).toBeDisabled();

  const offButtons = screen.getAllByRole("button", { name: "Off" });
  expect(offButtons).toHaveLength(4);
  await userEvent.click(offButtons[0]);
  expect(screen.getByRole("button", { name: "On" })).toBeInTheDocument();
  await waitFor(() => expect(saveButton).not.toBeDisabled());
  await userEvent.click(saveButton);
  expect(await screen.findByText(/Saved timer changes for Kitchen Basil/i)).toBeInTheDocument();
  expect(saveButton).toBeDisabled();
});

it("keeps Plant Schedule timers visible when recommendation is available", async () => {
  render(
    <WateringRecommendationCard
      recommendation={mockRecommendation}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      potId="pot-1"
      potLabel="Kitchen Basil"
    />
  );
  await waitFor(() => expect(hubClient.fetchPlantControlSchedule).toHaveBeenCalledWith("pot-1", expect.anything()));

  expect(screen.getByRole("heading", { name: /plant schedule/i })).toBeInTheDocument();
  expect(screen.getByText("ET0 (mm/day)")).toBeInTheDocument();
  expect(screen.getByText(/Device Timers/i)).toBeInTheDocument();
  expect(screen.getByText(/Penman-Monteith baseline tuned for your pot profile/i)).toBeInTheDocument();
});

it("keeps timer state scoped to the selected pot", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <WateringRecommendationCard
      recommendation={null}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      potId="pot-a"
      potLabel="Pot A"
    />
  );
  await waitFor(() => expect(hubClient.fetchPlantControlSchedule).toHaveBeenCalledWith("pot-a", expect.anything()));

  expect(screen.getByText(/Managing schedule for Pot A/i)).toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "Off" })[0]);
  expect(screen.getByRole("button", { name: "On" })).toBeInTheDocument();

  rerender(
    <WateringRecommendationCard
      recommendation={null}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      potId="pot-b"
      potLabel="Pot B"
    />
  );
  await waitFor(() => expect(hubClient.fetchPlantControlSchedule).toHaveBeenCalledWith("pot-b", expect.anything()));
  expect(screen.getByText(/Managing schedule for Pot B/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "On" })).not.toBeInTheDocument();

  rerender(
    <WateringRecommendationCard
      recommendation={null}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      potId="pot-a"
      potLabel="Pot A"
    />
  );
  expect(screen.getByText(/Managing schedule for Pot A/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "On" })).toBeInTheDocument();
});

it("restores saved timers for the same pot after reload", async () => {
  const user = userEvent.setup();
  const { unmount } = render(
    <WateringRecommendationCard
      recommendation={null}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      potId="pot-1"
      potLabel="Kitchen Basil"
    />
  );
  await waitFor(() => expect(hubClient.fetchPlantControlSchedule).toHaveBeenCalledWith("pot-1", expect.anything()));

  await user.click(screen.getAllByRole("button", { name: "Off" })[0]);
  await waitFor(() => expect(screen.getByRole("button", { name: /save timer changes/i })).not.toBeDisabled());
  await user.click(screen.getByRole("button", { name: /save timer changes/i }));
  expect(await screen.findByText(/Saved timer changes for Kitchen Basil/i)).toBeInTheDocument();

  unmount();

  render(
    <WateringRecommendationCard
      recommendation={null}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      potId="pot-1"
      potLabel="Kitchen Basil"
    />
  );
  await waitFor(() => expect(hubClient.fetchPlantControlSchedule).toHaveBeenCalledWith("pot-1", expect.anything()));

  expect(screen.getByRole("button", { name: "On" })).toBeInTheDocument();
});
