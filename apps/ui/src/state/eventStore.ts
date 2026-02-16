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
  lightOn?: boolean | null;
  requestId?: string | null;
  timestamp?: string | null;
  timestampMs?: number | null;
  receivedAt: string;
  deviceName?: string | null;
  isNamed?: boolean | null;
  sensorMode?: string | null;
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

export type DeviceIdentity = {
  potId: string;
  deviceName?: string | null;
  isNamed?: boolean | null;
  lastSeen?: string | null;
  source?: string | null;
};

export type InitialSnapshot = {
  telemetry?: {
    environment?: TelemetrySample[];
  };
  status?: PumpStatusEvent[];
  jobs?: JobEvent[];
  alerts?: AlertEvent[];
  devices?: DeviceIdentity[];
};

type EventStoreState = {
  environmentTelemetry: TelemetrySample[];
  potTelemetry: Record<string, TelemetrySample[]>;
  potIdentities: Record<string, DeviceIdentity>;
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
  upsertPotIdentity: (identity: DeviceIdentity) => void;
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
    potIdentities: {},
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

function normalizePotId(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized ? normalized : null;
}

function mergeIdentity(existing: DeviceIdentity | undefined, update: DeviceIdentity): DeviceIdentity {
  return {
    potId: update.potId,
    deviceName: update.deviceName ?? existing?.deviceName ?? null,
    isNamed: update.isNamed ?? existing?.isNamed ?? null,
    lastSeen: update.lastSeen ?? existing?.lastSeen ?? null,
    source: update.source ?? existing?.source ?? null,
  };
}

export const useEventStore = create<EventStoreState>((set, get) => ({
  ...initialState,
  setInitialSnapshot: (snapshot) =>
    set(() => {
      const environment = sortByTimestamp(snapshot.telemetry?.environment ?? []);
      const pumpStatus: Record<string, PumpStatusEvent> = {};
      const potIdentities: Record<string, DeviceIdentity> = {};
      for (const entry of snapshot.status ?? []) {
        const potId = entry.potId?.trim().toLowerCase();
        if (potId) {
          pumpStatus[potId] = entry;
          if (entry.deviceName || entry.isNamed !== undefined) {
            potIdentities[potId] = mergeIdentity(potIdentities[potId], {
              potId,
              deviceName: entry.deviceName ?? null,
              isNamed: entry.isNamed ?? null,
              lastSeen: entry.receivedAt ?? null,
              source: "status",
            });
          }
        }
      }
      for (const entry of snapshot.devices ?? []) {
        const potId = normalizePotId(entry.potId);
        if (!potId) {
          continue;
        }
        potIdentities[potId] = mergeIdentity(potIdentities[potId], {
          ...entry,
          potId,
        });
      }
      const jobs: Record<string, JobEvent> = {};
      for (const job of snapshot.jobs ?? []) {
        jobs[job.jobId] = job;
      }
      return {
        environmentTelemetry: environment.slice(-MAX_ENVIRONMENT_SAMPLES),
        potTelemetry: {},
        potIdentities,
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
      const nextIdentities = { ...state.potIdentities };
      for (const sample of samples) {
        if (sample.deviceName || sample.isNamed !== undefined) {
          nextIdentities[normalized] = mergeIdentity(nextIdentities[normalized], {
            potId: normalized,
            deviceName: sample.deviceName ?? null,
            isNamed: sample.isNamed ?? null,
            lastSeen: sample.timestamp ?? null,
            source: sample.source ?? null,
          });
        }
      }
      return {
        potTelemetry: {
          ...state.potTelemetry,
          [normalized]: sortByTimestamp(samples).slice(-MAX_POT_SAMPLES_PER_POT),
        },
        potIdentities: nextIdentities,
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
      const potIdentities = { ...state.potIdentities };
      if (event.sample.deviceName || event.sample.isNamed !== undefined) {
        potIdentities[potId] = mergeIdentity(potIdentities[potId], {
          potId,
          deviceName: event.sample.deviceName ?? null,
          isNamed: event.sample.isNamed ?? null,
          lastSeen: event.sample.timestamp ?? null,
          source: event.sample.source ?? null,
        });
      }
      return {
        potTelemetry: { ...state.potTelemetry, [potId]: nextSeries },
        potIdentities,
        lastEventAt: now,
      };
    }),
  upsertPumpStatus: (event) =>
    set((state) => {
      const potId = event.potId?.trim().toLowerCase();
      if (!potId) {
        return state;
      }
      const potIdentities = { ...state.potIdentities };
      if (event.deviceName || event.isNamed !== undefined) {
        potIdentities[potId] = mergeIdentity(potIdentities[potId], {
          potId,
          deviceName: event.deviceName ?? null,
          isNamed: event.isNamed ?? null,
          lastSeen: event.receivedAt ?? null,
          source: "status",
        });
      }
      return {
        pumpStatus: { ...state.pumpStatus, [potId]: event },
        potIdentities,
        lastEventAt: Date.now(),
      };
    }),
  upsertPotIdentity: (identity) =>
    set((state) => {
      const potId = normalizePotId(identity.potId);
      if (!potId) {
        return state;
      }
      return {
        potIdentities: {
          ...state.potIdentities,
          [potId]: mergeIdentity(state.potIdentities[potId], { ...identity, potId }),
        },
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
export const selectPotIdentities = (state: EventStoreState) => state.potIdentities;
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
