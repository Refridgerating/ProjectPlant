import { create } from "zustand";

import type { TelemetrySample } from "../api/hubClient";

const MAX_ENVIRONMENT_SAMPLES = 500;
const MAX_POT_SAMPLES_PER_POT = 2000;
const MAX_ALERTS = 200;

export type TelemetryCategory = "environment" | "pot";

export type TelemetryEvent = {
  category: TelemetryCategory;
  sample: TelemetrySample & { potId?: string };
};

export type PumpStatusEvent = {
  potId: string;
  status?: string | null;
  pumpOn?: boolean | null;
  fanOn?: boolean | null;
  misterOn?: boolean | null;
  requestId?: string | null;
  timestamp?: string | null;
  timestampMs?: number | null;
  receivedAt: string;
};

export type JobEvent = {
  jobId: string;
  status: string;
  command: string;
  potId?: string | null;
  requestId?: string | null;
  message?: string | null;
  error?: string | null;
  payload?: Record<string, unknown> | null;
  updatedAt: string;
};

export type AlertEvent = {
  id: string;
  level: string;
  message: string;
  timestamp: string;
  detail?: string | null;
  context?: Record<string, unknown> | null;
  recovered?: boolean;
};

export type InitialSnapshot = {
  telemetry?: {
    environment?: TelemetrySample[];
  };
  status?: PumpStatusEvent[];
  jobs?: JobEvent[];
  alerts?: AlertEvent[];
};

type EventStoreState = {
  environmentTelemetry: TelemetrySample[];
  potTelemetry: Record<string, TelemetrySample[]>;
  pumpStatus: Record<string, PumpStatusEvent>;
  jobs: Record<string, JobEvent>;
  alerts: AlertEvent[];
  lastEventAt: number | null;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  reconnectAttempts: number;
  setInitialSnapshot: (snapshot: InitialSnapshot) => void;
  seedPotTelemetry: (potId: string, samples: TelemetrySample[]) => void;
  upsertTelemetry: (event: TelemetryEvent) => void;
  upsertPumpStatus: (event: PumpStatusEvent) => void;
  upsertJob: (event: JobEvent) => void;
  pushAlert: (event: AlertEvent) => void;
  setConnectionState: (
    state: Partial<Pick<EventStoreState, "connected" | "connecting" | "error" | "reconnectAttempts">>
  ) => void;
  clear: () => void;
};

const initialState: Omit<EventStoreState, "setInitialSnapshot" | "upsertTelemetry" | "upsertPumpStatus" | "upsertJob" | "pushAlert" | "clear"> =
  {
    environmentTelemetry: [],
    potTelemetry: {},
    pumpStatus: {},
    jobs: {},
    alerts: [],
    lastEventAt: null,
    connected: false,
    connecting: false,
    error: null,
    reconnectAttempts: 0,
  };

function sortByTimestamp(data: TelemetrySample[]): TelemetrySample[] {
  return [...data].sort((a, b) => {
    const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return at - bt;
  });
}

export const useEventStore = create<EventStoreState>((set, get) => ({
  ...initialState,
  setInitialSnapshot: (snapshot) =>
    set(() => {
      const environment = sortByTimestamp(snapshot.telemetry?.environment ?? []);
      const pumpStatus: Record<string, PumpStatusEvent> = {};
      for (const entry of snapshot.status ?? []) {
        const potId = entry.potId?.trim().toLowerCase();
        if (potId) {
          pumpStatus[potId] = entry;
        }
      }
      const jobs: Record<string, JobEvent> = {};
      for (const job of snapshot.jobs ?? []) {
        jobs[job.jobId] = job;
      }
      return {
        environmentTelemetry: environment.slice(-MAX_ENVIRONMENT_SAMPLES),
        potTelemetry: {},
        pumpStatus,
        jobs,
        alerts: (snapshot.alerts ?? []).slice(-MAX_ALERTS),
        lastEventAt: Date.now(),
      };
    }),
  seedPotTelemetry: (potId, samples) =>
    set((state) => {
      const normalized = potId.trim().toLowerCase();
      if (!normalized) {
        return state;
      }
      return {
        potTelemetry: {
          ...state.potTelemetry,
          [normalized]: sortByTimestamp(samples).slice(-MAX_POT_SAMPLES_PER_POT),
        },
      };
    }),
  upsertTelemetry: (event) =>
    set((state) => {
      const now = Date.now();
      if (event.category === "environment") {
        const next = [...state.environmentTelemetry, event.sample];
        return {
          environmentTelemetry: sortByTimestamp(next).slice(-MAX_ENVIRONMENT_SAMPLES),
          lastEventAt: now,
        };
      }
      const potId = (event.sample.potId ?? "").trim().toLowerCase();
      if (!potId) {
        return { lastEventAt: now };
      }
      const existing = state.potTelemetry[potId] ?? [];
      const nextSeries = sortByTimestamp([...existing, event.sample]).slice(-MAX_POT_SAMPLES_PER_POT);
      return {
        potTelemetry: { ...state.potTelemetry, [potId]: nextSeries },
        lastEventAt: now,
      };
    }),
  upsertPumpStatus: (event) =>
    set((state) => {
      const potId = event.potId?.trim().toLowerCase();
      if (!potId) {
        return state;
      }
      return {
        pumpStatus: { ...state.pumpStatus, [potId]: event },
        lastEventAt: Date.now(),
      };
    }),
  upsertJob: (event) =>
    set((state) => ({
      jobs: { ...state.jobs, [event.jobId]: event },
      lastEventAt: Date.now(),
    })),
  pushAlert: (event) =>
    set((state) => {
      const next = [...state.alerts, event];
      if (next.length > MAX_ALERTS) {
        next.splice(0, next.length - MAX_ALERTS);
      }
      return {
        alerts: next,
        lastEventAt: Date.now(),
      };
    }),
  setConnectionState: (partial) =>
    set((state) => ({
      connected: partial.connected ?? state.connected,
      connecting: partial.connecting ?? state.connecting,
      error: partial.error !== undefined ? partial.error : state.error,
      reconnectAttempts: partial.reconnectAttempts ?? state.reconnectAttempts,
    })),
  clear: () => set(() => ({ ...initialState })),
}));

export const selectEnvironmentTelemetry = (state: EventStoreState) => state.environmentTelemetry;
export const selectPotTelemetry = (potId: string) => (state: EventStoreState) =>
  state.potTelemetry[potId.trim().toLowerCase()] ?? [];
export const selectPumpStatus = (state: EventStoreState) => state.pumpStatus;
export const selectJobs = (state: EventStoreState) => state.jobs;
export const selectAlerts = (state: EventStoreState) => state.alerts;
export const selectLastEventAt = (state: EventStoreState) => state.lastEventAt;
export const selectConnectionState = (state: EventStoreState) => ({
  connected: state.connected,
  connecting: state.connecting,
  error: state.error,
  reconnectAttempts: state.reconnectAttempts,
});
