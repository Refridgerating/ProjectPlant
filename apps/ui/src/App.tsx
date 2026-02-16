import { ArrowDownTrayIcon, ArrowPathIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHubInfo } from "./hooks/useHubInfo";
import { useGeolocation } from "./hooks/useGeolocation";
import { useLocalWeather } from "./hooks/useLocalWeather";
import { useTelemetry } from "./hooks/useTelemetry";
import { useEventSource } from "./hooks/useEventSource";
import { useWateringRecommendation, WateringRecommendationState } from "./hooks/useWateringRecommendation";
import { CorsOriginsCard } from "./components/CorsOriginsCard";
import { MqttDiagnostics } from "./components/MqttDiagnostics";
import { PageShell } from "./components/PageShell";
import { HubHeroTile } from "./components/HubHeroTile";
import { TelemetryChart } from "./components/TelemetryChart";
import { TelemetrySummary } from "./components/TelemetrySummary";
import { TelemetryTable } from "./components/TelemetryTable";
import { WateringRecommendationCard } from "./components/WateringRecommendationCard";
import { LocalConditionsMap } from "./components/LocalConditionsMap";
import { MyPlantsTab } from "./components/MyPlantsTab";
import { CacheManagerPanel } from "./components/CacheManagerPanel";
import { StatusBar } from "./components/StatusBar";
import { ConnectionBadges } from "./components/ConnectionBadges";
import { SettingsPanel } from "./components/SettingsPanel";
import { PenmanMonteithEquation } from "./components/PenmanMonteithEquation";
import { WaterModelSection } from "./components/WaterModelSection";
import { CollapsibleTile } from "./components/CollapsibleTile";
import { DeviceNamingPrompt } from "./components/DeviceNamingPrompt";
import { useSensorRead } from "./hooks/useSensorRead";
import { usePumpControl } from "./hooks/usePumpControl";
import { useFanControl } from "./hooks/useFanControl";
import { useMisterControl } from "./hooks/useMisterControl";
import { useLightControl } from "./hooks/useLightControl";
import {
  TelemetrySample,
  SensorReadPayload,
  exportPotTelemetry,
  fetchPotTelemetry,
  updateDeviceName,
  updateSensorMode,
} from "./api/hubClient";
import { useHealthDiagnostics } from "./hooks/useHealthDiagnostics";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
import { getSettings, RuntimeMode } from "./settings";
import {
  useEventStore,
  selectPotTelemetry,
  selectPumpStatus,
  selectConnectionState,
  selectPotIdentities,
  selectLastEventAt,
  type DeviceIdentity,
} from "./state/eventStore";

const LOCAL_RANGE_OPTIONS = [
  { label: "Current", value: 0 },
  { label: "30 minutes", value: 0.5 },
  { label: "1 hour", value: 1 },
  { label: "2 hours", value: 2 },
  { label: "6 hours", value: 6 },
  { label: "12 hours", value: 12 },
  { label: "24 hours", value: 24 },
  { label: "48 hours", value: 48 },
  { label: "72 hours", value: 72 },
] as const;

type LocalRange = (typeof LOCAL_RANGE_OPTIONS)[number]["value"];

const TELEMETRY_RANGE_PRESETS = [
  { key: "7d", label: "Last 7 days", hours: 7 * 24, limit: 7 * 24 * 3600 },
  { key: "6d", label: "Last 6 days", hours: 6 * 24, limit: 6 * 24 * 3600 },
  { key: "5d", label: "Last 5 days", hours: 5 * 24, limit: 5 * 24 * 3600 },
  { key: "4d", label: "Last 4 days", hours: 4 * 24, limit: 4 * 24 * 3600 },
  { key: "3d", label: "Last 3 days", hours: 3 * 24, limit: 3 * 24 * 3600 },
  { key: "2d", label: "Last 2 days", hours: 2 * 24, limit: 2 * 24 * 3600 },
  { key: "1d", label: "Last 24 hours", hours: 24, limit: 24 * 3600 },
  { key: "16h", label: "Last 16 hours", hours: 16, limit: 16 * 3600 },
  { key: "12h", label: "Last 12 hours", hours: 12, limit: 12 * 3600 },
  { key: "8h", label: "Last 8 hours", hours: 8, limit: 8 * 3600 },
  { key: "4h", label: "Last 4 hours", hours: 4, limit: 4 * 3600 },
  { key: "2h", label: "Last 2 hours", hours: 2, limit: 2 * 3600 },
  { key: "1h", label: "Last 1 hour", hours: 1, limit: 1 * 3600 },
  { key: "45m", label: "Last 45 minutes", hours: 45 / 60, limit: 45 * 60 },
  { key: "30m", label: "Last 30 minutes", hours: 30 / 60, limit: 30 * 60 },
  { key: "15m", label: "Last 15 minutes", hours: 15 / 60, limit: 15 * 60 },
  { key: "5m", label: "Last 5 minutes", hours: 5 / 60, limit: 5 * 60 },
] as const;

type TelemetryRangePreset = (typeof TELEMETRY_RANGE_PRESETS)[number];
type TelemetryRangeKey = TelemetryRangePreset["key"];

const TELEMETRY_RANGE_PRESET_MAP: Record<TelemetryRangeKey, TelemetryRangePreset> = TELEMETRY_RANGE_PRESETS.reduce(
  (acc, preset) => {
    acc[preset.key] = preset;
    return acc;
  },
  {} as Record<TelemetryRangeKey, TelemetryRangePreset>
);

const DEFAULT_TELEMETRY_RANGE_KEY: TelemetryRangeKey = "1d";
const MAX_CHART_POINTS = 10_000;
const DEFAULT_POT_TELEMETRY_CAP = 4_096;
const HEALTH_REFRESH_THROTTLE_MS = 15_000;
const HEALTH_REFRESH_POLL_MS = 30_000;
const CONTROL_POT_STORAGE_KEY = "projectplant:plant-control:selected-pot:v1";

const CONTROL_DEVICES = [
  { id: "pump", label: "H2O Pump" },
  { id: "fan", label: "Fan" },
  { id: "light", label: "Grow Light" },
  { id: "feeder", label: "Feeder" },
  { id: "mister", label: "Mister" },
] as const;

type ControlDeviceId = (typeof CONTROL_DEVICES)[number]["id"];
type ControlStates = Record<ControlDeviceId, boolean>;
type HubTab = "plant" | "control" | "local" | "myplants" | "diagnostics";
const DEFAULT_TELEMETRY_POTS = ["pot-01"];

const DEFAULT_WATERING_OPTIONS = {
  potDiameterCm: 26,
  potHeightCm: 24,
  cropCoefficient: 0.9,
  plantName: "Indoor Tropical",
  lookbackHours: 24,
  availableWaterFraction: 0.42,
  irrigationEfficiency: 0.88,
  targetRefillFraction: 0.5,
  assumedWindSpeed: 0.12,
  netRadiationFactor: 0.7,
} as const;

function formatMaybeNumber(value: number | null | undefined, fractionDigits: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return value.toFixed(fractionDigits);
}

const SOURCE_LABELS: Record<string, string> = {
  nasa_power: "NASA POWER",
  noaa_nws: "NOAA NWS",
  noaa_hrrr: "NOAA HRRR",
};

function formatSourceTag(tag: string): string {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const mapped = SOURCE_LABELS[normalized];
  if (mapped) {
    return mapped;
  }
  return normalized
    .split(/[_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatIsoTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "Timestamp unavailable";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function LoadingState({ message = "Loading hub status..." }: { message?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-emerald-700/50 bg-[rgba(8,33,23,0.78)] px-4 py-3 text-emerald-100 shadow-inner shadow-emerald-950/40">
      <span className="inline-flex h-3 w-3 animate-ping rounded-full bg-emerald-400/90" />
      {message}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-rose-500/40 bg-[rgba(45,12,18,0.85)] p-6 text-rose-100 shadow-[0_20px_50px_rgba(30,10,16,0.4)]">
      <h2 className="text-lg font-semibold text-rose-100">Unable to reach the hub</h2>
      <p className="mt-2 text-sm text-rose-200/80">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/80 px-4 py-2 text-sm font-semibold text-rose-50 transition hover:border-rose-400/50 hover:bg-rose-400"
      >
        <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
        Try again
      </button>
    </div>
  );
}

function LocationPrompt({
  status,
  error,
  onEnable,
}: {
  status: ReturnType<typeof useGeolocation>["status"];
  error: string | null;
  onEnable: () => void;
}) {
  if (status === "unsupported") {
    return (
      <CollapsibleTile
        id="local-location-unsupported"
        title="Location access unavailable"
        subtitle="This browser does not support geolocation, so we cannot load nearby weather stations automatically."
        className="text-sm text-emerald-100/85"
        bodyClassName="mt-2 space-y-2"
      >
        <p>Please enter a location manually in settings or use a browser that supports geolocation.</p>
      </CollapsibleTile>
    );
  }

  if (status === "pending") {
    return <LoadingState message="Requesting location permission..." />;
  }

  return (
    <CollapsibleTile
      id="local-location-enable"
      title="Enable location services"
      subtitle="Share your approximate location to pull observations from the closest public weather station."
      className="text-sm text-emerald-100/85"
      bodyClassName="mt-2 space-y-2"
    >
      <p>
        Coordinates stay on your device and are only sent to the hub to resolve the station. You can revoke access at any
        time from your browser settings.
      </p>
      {error ? <p className="text-rose-300">{error}</p> : null}
      <button
        type="button"
        onClick={onEnable}
        className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/50 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300 hover:bg-emerald-500/20"
      >
        Grant Location Access
      </button>
    </CollapsibleTile>
  );
}

function LocalRangeSelector({
  value,
  options,
  onChange,
}: {
  value: LocalRange;
  options: LocalRange[];
  onChange: (value: LocalRange) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm text-emerald-100/80">
      <span className="text-emerald-200/60">Range</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value) as LocalRange)}
        className="rounded-lg border border-emerald-600/40 bg-[rgba(8,32,22,0.88)] px-3 py-2 text-emerald-100 shadow-inner shadow-emerald-950/40 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
      >
        {options.map((option) => {
          const label = LOCAL_RANGE_OPTIONS.find((item) => item.value === option)?.label ?? `${option} hours`;
          return (
            <option key={option} value={option}>
              {label}
            </option>
          );
        })}
      </select>
    </label>
  );
}

type TelemetrySourceOption = {
  value: string;
  label: string;
};

function TelemetrySourceSelector({
  value,
  options,
  onChange,
}: {
  value: string;
  options: TelemetrySourceOption[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm text-emerald-100/80">
      <span className="text-emerald-200/60">Series</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-emerald-600/40 bg-[rgba(8,32,22,0.88)] px-3 py-2 text-emerald-100 shadow-inner shadow-emerald-950/40 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TelemetryRangeSelector({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: TelemetryRangeKey;
  options: readonly TelemetryRangePreset[];
  onChange: (value: TelemetryRangeKey) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-3 text-sm text-emerald-100/80">
      <span className="text-emerald-200/60">Range</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as TelemetryRangeKey)}
        disabled={disabled}
        title={disabled ? "Range presets are not available for demo telemetry." : undefined}
        className="rounded-lg border border-emerald-600/40 bg-[rgba(8,32,22,0.88)] px-3 py-2 text-emerald-100 shadow-inner shadow-emerald-950/40 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatPotLabel(potId: string): string {
  const normalized = potId.trim();
  if (!normalized) {
    return "Unknown Pot";
  }
  const parts = normalized.split(/[-_]/).filter(Boolean);
  if (!parts.length) {
    return normalized;
  }
  const formatted = parts
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
  return formatted;
}

type PersistedControlPotSelection = {
  selectedPotId?: string;
  useCustomPotId?: boolean;
  customPotId?: string;
};

function loadPersistedControlPotSelection(): PersistedControlPotSelection {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(CONTROL_POT_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    return {
      selectedPotId:
        typeof record.selectedPotId === "string" ? record.selectedPotId.trim().toLowerCase() : undefined,
      useCustomPotId: typeof record.useCustomPotId === "boolean" ? record.useCustomPotId : undefined,
      customPotId: typeof record.customPotId === "string" ? record.customPotId : undefined,
    };
  } catch {
    return {};
  }
}

function persistControlPotSelection(selection: {
  selectedPotId: string;
  useCustomPotId: boolean;
  customPotId: string;
}) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CONTROL_POT_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Ignore local storage failures; selection will still work for this session.
  }
}

export default function App() {
  const { data, loading, error, refresh } = useHubInfo();
  const {
    summary: healthSummary,
    mqtt: healthMqtt,
    weather: healthWeather,
    storage: healthStorage,
    events: healthEvents,
    eventsCount: healthEventsCount,
    loading: healthLoading,
    error: healthError,
    refresh: refreshHealth,
  } = useHealthDiagnostics();
  const potTelemetryMaxRows = useMemo(() => {
    const raw = data?.pot_telemetry_max_rows;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw;
    }
    return DEFAULT_POT_TELEMETRY_CAP;
  }, [data]);
  const initialSettings = getSettings();
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(initialSettings.mode);
  const initialTelemetrySource = initialSettings.mode === "live" ? DEFAULT_TELEMETRY_POTS[0] : "mock";
  useEventSource(runtimeMode === "live");
  const eventConnectionState = useEventStore(selectConnectionState);
  const lastEventAt = useEventStore(selectLastEventAt);
  const {
    data: telemetryRaw,
    loading: telemetryLoading,
    error: telemetryError,
    refresh: refreshTelemetry,
  } = useTelemetry({ mode: runtimeMode, samples: 96, hours: 24 });
  const [telemetrySource, setTelemetrySource] = useState<string>(initialTelemetrySource);
  const seedPotTelemetry = useEventStore((state) => state.seedPotTelemetry);
  const telemetrySelector = useMemo(
    () => (telemetrySource === "mock" ? () => [] : selectPotTelemetry(telemetrySource)),
    [telemetrySource]
  );
  const currentPotTelemetry = useEventStore(telemetrySelector);
  const [telemetryRangeKey, setTelemetryRangeKey] = useState<TelemetryRangeKey>(DEFAULT_TELEMETRY_RANGE_KEY);
  const telemetryRange = TELEMETRY_RANGE_PRESET_MAP[telemetryRangeKey] ?? TELEMETRY_RANGE_PRESETS[0];
  const telemetryRangeLimit = Math.max(1, Math.round(telemetryRange.limit));
  const potTelemetryLimit = Math.max(1, Math.min(telemetryRangeLimit, potTelemetryMaxRows));
  const telemetryLimitClamped = potTelemetryLimit < telemetryRangeLimit;
  const potTelemetryRangeLabel = useMemo(() => {
    if (telemetrySource === "mock") {
      return telemetryRange.label;
    }
    if (telemetryLimitClamped) {
      return `${telemetryRange.label} (showing latest ${potTelemetryLimit.toLocaleString()} samples)`;
    }
    return telemetryRange.label;
  }, [telemetrySource, telemetryRange, telemetryLimitClamped, potTelemetryLimit]);
  const [potTelemetryLoading, setPotTelemetryLoading] = useState(false);
  const [potTelemetryError, setPotTelemetryError] = useState<string | null>(null);
  const geolocation = useGeolocation();
  const [localRange, setLocalRange] = useState<LocalRange>(6);
  const [activeChartTab, setActiveChartTab] = useState<HubTab>("plant");
  const [controlStates, setControlStates] = useState<ControlStates>(() =>
    CONTROL_DEVICES.reduce((acc, device) => {
      acc[device.id] = false;
      return acc;
    }, {} as ControlStates)
  );
  const {
    data: localWeather,
    latest: localLatest,
    loading: localLoading,
    error: localError,
    coverageHours,
    availableWindows,
    station: localStation,
    sources: localSources,
    hrrrUsed: localHrrrUsed,
    hrrrError: localHrrrError,
    refresh: refreshLocal,
  } = useLocalWeather(geolocation.coords, localRange, { maxSamples: 200 });
  const latestSourceDisplay = useMemo(() => {
    if (localHrrrUsed) {
      return "NOAA HRRR Forecast";
    }
    const tags = localSources.length
      ? localSources
      : (localLatest?.source ?? "")
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
    if (!tags.length) {
      return null;
    }
    const labels = tags.map((tag) => formatSourceTag(tag));
    const unique = Array.from(new Set(labels.filter((label) => label.length > 0)));
    return unique.length ? unique.join(" + ") : null;
  }, [localSources, localLatest?.source, localHrrrUsed]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cacheManagerOpen, setCacheManagerOpen] = useState(false);
  const [serverHint, setServerHint] = useState<string>(initialSettings.serverBaseUrl);
  const [potTelemetryTicker, setPotTelemetryTicker] = useState(0);
  const [telemetryExporting, setTelemetryExporting] = useState(false);
  const [telemetryExportStatus, setTelemetryExportStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const telemetryExportTimeoutRef = useRef<number | null>(null);

  const showTelemetryExportStatus = useCallback(
    (status: { type: "success" | "error"; message: string } | null) => {
      setTelemetryExportStatus(status);
      if (telemetryExportTimeoutRef.current != null) {
        window.clearTimeout(telemetryExportTimeoutRef.current);
        telemetryExportTimeoutRef.current = null;
      }
      if (status) {
        telemetryExportTimeoutRef.current = window.setTimeout(() => {
          telemetryExportTimeoutRef.current = null;
          setTelemetryExportStatus(null);
        }, 10000);
      }
    },
    []
  );

  useEffect(() => {
    return () => {
      if (telemetryExportTimeoutRef.current != null) {
        window.clearTimeout(telemetryExportTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (geolocation.status !== "granted" || !geolocation.coords) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      refreshLocal();
    }, 60 * 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, [geolocation.status, geolocation.coords, refreshLocal]);

  const availablePotIds = useEventStore((state) => Object.keys(state.potTelemetry));
  const pumpStatusPotIds = useEventStore((state) => Object.keys(state.pumpStatus));
  const potIdentities = useEventStore(selectPotIdentities);
  const [dismissedPotIds, setDismissedPotIds] = useState<string[]>([]);
  const [namingTarget, setNamingTarget] = useState<DeviceIdentity | null>(null);
  const healthRefreshRef = useRef(0);
  const requestHealthRefresh = useCallback(
    (force = false) => {
      const now = Date.now();
      if (!force && now - healthRefreshRef.current < HEALTH_REFRESH_THROTTLE_MS) {
        return;
      }
      healthRefreshRef.current = now;
      refreshHealth();
    },
    [refreshHealth]
  );
  const heartbeatPotIds = useMemo(() => {
    const pots = healthMqtt?.heartbeat?.pots ?? [];
    const ids = pots
      .map((entry) => (entry.pot_id ?? "").trim().toLowerCase())
      .filter((id) => id.length > 0);
    return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
  }, [healthMqtt]);
  const controlPotIds = useMemo(() => {
    const identifiers = new Set<string>();
    availablePotIds.forEach((id) => identifiers.add(id));
    pumpStatusPotIds.forEach((id) => identifiers.add(id));
    heartbeatPotIds.forEach((id) => identifiers.add(id));
    return Array.from(identifiers)
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0)
      .sort((a, b) => a.localeCompare(b));
  }, [availablePotIds, pumpStatusPotIds, heartbeatPotIds]);

  const resolvePotLabel = useCallback(
    (potId: string) => {
      const normalized = potId.trim().toLowerCase();
      const identity = potIdentities[normalized];
      const displayName = identity?.deviceName?.trim();
      if (displayName) {
        return displayName;
      }
      return formatPotLabel(potId);
    },
    [potIdentities]
  );

  const unnamedDevices = useMemo(() => {
    const dismissed = new Set(dismissedPotIds);
    return Object.values(potIdentities)
      .filter((device) => device.isNamed === false && !dismissed.has(device.potId))
      .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));
  }, [potIdentities, dismissedPotIds]);

  useEffect(() => {
    if (namingTarget) {
      const refreshed = potIdentities[namingTarget.potId];
      if (!refreshed || refreshed.isNamed !== false) {
        setNamingTarget(null);
        return;
      }
      if (refreshed !== namingTarget) {
        setNamingTarget(refreshed);
      }
      return;
    }
    if (unnamedDevices.length) {
      setNamingTarget(unnamedDevices[0]);
    }
  }, [namingTarget, potIdentities, unnamedDevices]);

  useEffect(() => {
    if (runtimeMode !== "live" || !lastEventAt) {
      return;
    }
    requestHealthRefresh();
  }, [lastEventAt, requestHealthRefresh, runtimeMode]);

  useEffect(() => {
    if (runtimeMode !== "live") {
      return;
    }
    const interval = window.setInterval(() => {
      requestHealthRefresh();
    }, HEALTH_REFRESH_POLL_MS);
    return () => window.clearInterval(interval);
  }, [requestHealthRefresh, runtimeMode]);

  useEffect(() => {
    setDismissedPotIds((prev) => prev.filter((id) => potIdentities[id]?.isNamed === false));
  }, [potIdentities]);

  useEffect(() => {
    const entries = healthMqtt?.heartbeat?.pots ?? [];
    if (!entries.length) {
      return;
    }
    const store = useEventStore.getState();
    entries.forEach((entry) => {
      const potId = (entry.pot_id ?? "").trim().toLowerCase();
      if (!potId) {
        return;
      }
      if (entry.deviceName || entry.isNamed !== undefined) {
        store.upsertPotIdentity({
          potId,
          deviceName: entry.deviceName ?? null,
          isNamed: entry.isNamed ?? null,
          lastSeen: entry.received_at ?? null,
          source: "heartbeat",
        });
      }
    });
  }, [healthMqtt]);

  const telemetryOptions = useMemo<TelemetrySourceOption[]>(() => {
    const identifiers = new Set<string>();
    DEFAULT_TELEMETRY_POTS.forEach((id) => identifiers.add(id));
    availablePotIds.forEach((id) => identifiers.add(id));
    if (telemetrySource !== "mock" && telemetrySource.trim()) {
      identifiers.add(telemetrySource.trim());
    }
    const potIds = Array.from(identifiers)
      .filter((id) => id.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));
    return [
      { value: "mock", label: "Demo Telemetry" },
      ...potIds.map((potId) => ({ value: potId, label: resolvePotLabel(potId) })),
    ];
  }, [availablePotIds, telemetrySource, resolvePotLabel]);

  const mergeTelemetryWithWeather = useCallback(
    (samples: TelemetrySample[]) => {
      if (!samples.length) {
        return samples;
      }
      const weatherWithTime = localWeather
        .map((entry) => ({ entry, time: entry.timestamp ? new Date(entry.timestamp).getTime() : null }))
        .filter((item) => item.time !== null && !Number.isNaN(item.time))
        .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

      let weatherIndex = 0;
      const merged = samples
        .map((sample) => {
          const timeValue = sample.timestamp ? new Date(sample.timestamp).getTime() : null;
          let pressure = sample.pressure_hpa ?? null;
          let solar = sample.solar_radiation_w_m2 ?? null;
          let wind = sample.wind_speed_m_s ?? null;

          if (weatherWithTime.length && timeValue !== null && !Number.isNaN(timeValue)) {
            while (
              weatherIndex < weatherWithTime.length - 1 &&
              Math.abs((weatherWithTime[weatherIndex + 1].time ?? timeValue) - timeValue) <=
                Math.abs((weatherWithTime[weatherIndex].time ?? timeValue) - timeValue)
            ) {
              weatherIndex += 1;
            }
            const nearest = weatherWithTime[weatherIndex]?.entry;
            if (nearest) {
              if (pressure === null && nearest.pressure_hpa != null) {
                pressure = nearest.pressure_hpa;
              }
              if (solar === null && nearest.solar_radiation_w_m2 != null) {
                solar = nearest.solar_radiation_w_m2;
              }
              if (wind === null && nearest.wind_speed_m_s != null) {
                wind = nearest.wind_speed_m_s;
              }
            }
          }

          return {
            ...sample,
            pressure_hpa: pressure,
            solar_radiation_w_m2: solar,
            wind_speed_m_s: wind,
            moisture_pct: sample.moisture_pct ?? null,
            source: sample.source ?? "sensor",
          };
        })
        .sort((a, b) => {
          const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return at - bt;
        });
      return merged;
    },
    [localWeather]
  );

  const mockTelemetry = useMemo(() => mergeTelemetryWithWeather(telemetryRaw), [telemetryRaw, mergeTelemetryWithWeather]);

  const displayTelemetry = useMemo(() => {
    if (telemetrySource === "mock") {
      return mockTelemetry;
    }
    return mergeTelemetryWithWeather(currentPotTelemetry ?? []);
  }, [telemetrySource, mockTelemetry, currentPotTelemetry, mergeTelemetryWithWeather]);

  const chartSeriesInfo = useMemo(() => {
    if (displayTelemetry.length <= MAX_CHART_POINTS) {
      return { data: displayTelemetry, downsampledFrom: null as number | null };
    }
    const step = Math.ceil(displayTelemetry.length / MAX_CHART_POINTS);
    const reduced: TelemetrySample[] = [];
    for (let index = 0; index < displayTelemetry.length; index += step) {
      reduced.push(displayTelemetry[index]);
    }
    const last = displayTelemetry[displayTelemetry.length - 1];
    if (reduced[reduced.length - 1] !== last) {
      reduced.push(last);
    }
    return {
      data: reduced,
      downsampledFrom: displayTelemetry.length,
    };
  }, [displayTelemetry]);
  const chartSeries = chartSeriesInfo.data;
  const chartDownsampledFrom = chartSeriesInfo.downsampledFrom;

  const displayLatest = useMemo(
    () => (displayTelemetry.length ? displayTelemetry[displayTelemetry.length - 1] : null),
    [displayTelemetry]
  );

  const watering = useWateringRecommendation(mockTelemetry, DEFAULT_WATERING_OPTIONS);

  const plantTelemetrySubtitle = useMemo(() => {
    if (telemetrySource === "mock") {
      if (telemetryError) {
        return `Telemetry unavailable: ${telemetryError}`;
      }
      if (telemetryLoading && !mockTelemetry.length) {
        return runtimeMode === "live" ? "Loading live sensor telemetry..." : "Loading demo telemetry...";
      }
      return runtimeMode === "live"
        ? "Live sensor data captured from the hub sensors."
        : "Demo telemetry generated for preview mode. Switch to Live in settings.";
    }
    const label = resolvePotLabel(telemetrySource);
    const rangeLabel = potTelemetryRangeLabel;
    if (potTelemetryError) {
      return `Telemetry unavailable for ${label}: ${potTelemetryError}`;
    }
    if (potTelemetryLoading && !displayTelemetry.length) {
      return `Loading telemetry for ${label} (${rangeLabel})...`;
    }
    if (!displayTelemetry.length) {
      return `Waiting for sensor snapshots from ${label} in ${rangeLabel.toLowerCase()}. Run a Sensor Read to capture a data point.`;
    }
    const totalSamples = displayTelemetry.length;
    const sampleLabel = `${totalSamples.toLocaleString()} sample${totalSamples === 1 ? "" : "s"}`;
    const parts = [`Manual sensor reads for ${label}`, rangeLabel, sampleLabel];
    let summary = parts.join(" | ");
    if (chartDownsampledFrom) {
      summary += ` (down-sampled to ${chartSeries.length.toLocaleString()} points for charting)`;
    }
    return summary;
  }, [
    telemetrySource,
    telemetryError,
    telemetryLoading,
    runtimeMode,
    mockTelemetry.length,
    displayTelemetry.length,
    potTelemetryError,
    potTelemetryLoading,
    potTelemetryRangeLabel,
    chartDownsampledFrom,
    chartSeries.length,
    resolvePotLabel,
  ]);

  const handleTelemetryExport = useCallback(async () => {
    const normalized = telemetrySource.trim().toLowerCase();
    if (!normalized) {
      showTelemetryExportStatus({
        type: "error",
        message: "Select a smart pot to export telemetry data.",
      });
      return;
    }
    if (normalized === "mock") {
      showTelemetryExportStatus({
        type: "error",
        message: "Switch to a specific pot to export telemetry data.",
      });
      return;
    }
    const potLabel = resolvePotLabel(telemetrySource);
    const rangeLabel = potTelemetryRangeLabel;
    setTelemetryExporting(true);
    showTelemetryExportStatus({
      type: "success",
      message: `Preparing export for ${potLabel} (${rangeLabel})...`,
    });
    try {
      const { blob, filename } = await exportPotTelemetry(normalized, {
        hours: telemetryRange.hours,
        limit: potTelemetryLimit,
      });
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = filename;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      showTelemetryExportStatus({
        type: "success",
        message: `Download started for ${potLabel} (${rangeLabel}) - ${filename}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to export telemetry.";
      showTelemetryExportStatus({ type: "error", message });
    } finally {
      setTelemetryExporting(false);
    }
  }, [
    telemetrySource,
    telemetryRange,
    potTelemetryRangeLabel,
    potTelemetryLimit,
    showTelemetryExportStatus,
    resolvePotLabel,
  ]);

  const telemetryActions = useMemo(() => {
    const status = telemetryExportStatus ? (
      <span
        className={
          telemetryExportStatus.type === "success"
            ? "text-xs font-medium text-emerald-200/80"
            : "text-xs font-medium text-rose-200/80"
        }
        role="status"
        aria-live="polite"
      >
        {telemetryExportStatus.message}
      </span>
    ) : null;
    const buttonTitle =
      telemetrySource === "mock"
        ? "Switch to a specific pot to export telemetry data."
        : `Export telemetry for ${resolvePotLabel(telemetrySource)} (${potTelemetryRangeLabel})`;
    return (
      <div className="flex items-center gap-3">
        {status}
        <button
          type="button"
          onClick={handleTelemetryExport}
          disabled={telemetryExporting}
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-100 transition hover:border-emerald-400 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          title={buttonTitle}
        >
          {telemetryExporting ? (
            <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
          )}
          {telemetryExporting ? "Preparing export..." : "Export CSV"}
        </button>
      </div>
    );
  }, [
    handleTelemetryExport,
    telemetryExporting,
    telemetryExportStatus,
    telemetrySource,
    potTelemetryRangeLabel,
    resolvePotLabel,
  ]);

  useEffect(() => {
    if (runtimeMode === "live" && telemetrySource === "mock") {
      setTelemetrySource(DEFAULT_TELEMETRY_POTS[0]);
    }
    if (runtimeMode === "demo" && telemetrySource !== "mock" && DEFAULT_TELEMETRY_POTS.includes(telemetrySource)) {
      setTelemetrySource("mock");
    }
  }, [runtimeMode, telemetrySource]);

  useEffect(() => {
    if (telemetrySource === "mock") {
      setPotTelemetryLoading(false);
      setPotTelemetryError(null);
      return;
    }
    const normalized = telemetrySource.trim().toLowerCase();
    if (!normalized) {
      return;
    }
    const controller = new AbortController();
    setPotTelemetryLoading(true);
    setPotTelemetryError(null);
    fetchPotTelemetry(
      normalized,
      { hours: telemetryRange.hours, limit: potTelemetryLimit },
      controller.signal
    )
      .then((samples) => {
        seedPotTelemetry(normalized, samples);
      })
      .catch((err) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to load pot telemetry";
        setPotTelemetryError(message);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setPotTelemetryLoading(false);
        }
      });
    return () => controller.abort();
  }, [telemetrySource, potTelemetryTicker, telemetryRange, potTelemetryLimit, seedPotTelemetry]);

  useEffect(() => {
    if (telemetrySource === "mock") {
      return;
    }
    const interval = window.setInterval(() => {
      setPotTelemetryTicker((prev) => prev + 1);
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [telemetrySource]);

  const handleSensorSnapshot = useCallback(
    (snapshot: SensorReadPayload) => {
      const normalizePotId = (value: string) => {
        const trimmed = value.trim().toLowerCase();
        return trimmed || "unknown-pot";
      };
      const potId = normalizePotId(snapshot.potId ?? "");
      const timestampIso = (() => {
        if (snapshot.timestamp) {
          const parsed = new Date(snapshot.timestamp);
          if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
          }
        }
        if (snapshot.timestampMs != null) {
          const parsed = new Date(snapshot.timestampMs);
          if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
          }
        }
        return new Date().toISOString();
      })();
      const toNumber = (value: unknown): number | null => {
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
        if (typeof value === "string" && value.trim()) {
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      };
      const weatherSnapshot = localWeather.length ? localWeather[localWeather.length - 1] : null;
      const normalizedPotId = potId.trim().toLowerCase();
      const sample = {
        timestamp: timestampIso,
        temperature_c: toNumber(snapshot.temperature),
        humidity_pct: toNumber(snapshot.humidity),
        moisture_pct: toNumber(snapshot.moisture),
        pressure_hpa: weatherSnapshot?.pressure_hpa ?? null,
        solar_radiation_w_m2: weatherSnapshot?.solar_radiation_w_m2 ?? null,
        wind_speed_m_s: weatherSnapshot?.wind_speed_m_s ?? null,
        station: potId,
        potId: normalizedPotId,
        source: "sensor-snapshot",
      } as TelemetrySample & { potId: string };
      const existing = useEventStore.getState().potTelemetry[normalizedPotId] ?? [];
      seedPotTelemetry(normalizedPotId, [...existing, sample]);
      setTelemetrySource(normalizedPotId);
    },
    [localWeather, seedPotTelemetry]
  );

  const availableRangeOptions = useMemo(() => {
    if (!availableWindows.length) {
      return LOCAL_RANGE_OPTIONS.map((opt) => opt.value);
    }
    const filtered = LOCAL_RANGE_OPTIONS.filter((opt) => availableWindows.includes(opt.value)).map((opt) => opt.value);
    return filtered.length ? filtered : LOCAL_RANGE_OPTIONS.map((opt) => opt.value);
  }, [availableWindows]);

  useEffect(() => {
    if (!availableRangeOptions.includes(localRange)) {
      const fallback = availableRangeOptions[availableRangeOptions.length - 1];
      setLocalRange(fallback as LocalRange);
    }
  }, [availableRangeOptions, localRange]);

  useEffect(() => {
    if (!localLatest?.timestamp) {
      return;
    }
    const ts = Date.parse(localLatest.timestamp);
    if (!Number.isFinite(ts)) {
      return;
    }
    const ageHours = Math.max((Date.now() - ts) / 3_600_000, 0);
    const normalizedAge = Math.max(0.5, Math.ceil(ageHours * 2) / 2);
    const candidate = availableRangeOptions.find((value) => value >= normalizedAge);
    if (candidate !== undefined && candidate > localRange) {
      setLocalRange(candidate as LocalRange);
    }
  }, [localLatest?.timestamp, availableRangeOptions, localRange]);

  const localLatestSubtitle = useMemo(() => {
    if (localLatest?.timestamp) {
      const label = formatIsoTimestamp(localLatest.timestamp);
      return localHrrrUsed ? `Forecast valid ${label}` : label;
    }
    if (localLoading) {
      return "Loading latest forecast...";
    }
    if (localError) {
      return `Latest forecast unavailable: ${localError}`;
    }
    return "Forecast timestamp unavailable";
  }, [localLatest?.timestamp, localLoading, localError, localHrrrUsed]);

  const title = useMemo(() => (data ? data.name : "ProjectPlant Hub"), [data]);

  const handleRefresh = useCallback(() => {
    refresh();
    refreshTelemetry();
    requestHealthRefresh(true);
    if (geolocation.coords) {
      refreshLocal();
    }
    if (telemetrySource !== "mock") {
      setPotTelemetryTicker((prev) => prev + 1);
    }
  }, [refresh, refreshTelemetry, requestHealthRefresh, geolocation.coords, refreshLocal, telemetrySource]);

  const handleNameSubmit = useCallback(
    async (deviceName: string) => {
      if (!namingTarget) {
        return;
      }
      const response = await updateDeviceName(namingTarget.potId, { deviceName, timeout: 10 });
      useEventStore.getState().upsertPotIdentity({
        potId: namingTarget.potId,
        deviceName: response.deviceName ?? deviceName,
        isNamed: response.isNamed ?? true,
        lastSeen: response.timestamp ?? new Date().toISOString(),
        source: "ui",
      });
      setDismissedPotIds((prev) => prev.filter((id) => id !== namingTarget.potId));
      setNamingTarget(null);
    },
    [namingTarget]
  );

  const handleManualRename = useCallback(async (potId: string, deviceName: string) => {
    const response = await updateDeviceName(potId, { deviceName, timeout: 10 });
    useEventStore.getState().upsertPotIdentity({
      potId,
      deviceName: response.deviceName ?? deviceName,
      isNamed: response.isNamed ?? true,
      lastSeen: response.timestamp ?? new Date().toISOString(),
      source: "ui",
    });
    return response;
  }, []);

  const handleDismissNamePrompt = useCallback(() => {
    if (namingTarget) {
      setDismissedPotIds((prev) =>
        prev.includes(namingTarget.potId) ? prev : [...prev, namingTarget.potId]
      );
    }
    setNamingTarget(null);
  }, [namingTarget]);

  const handleCloseSettings = () => {
    setSettingsOpen(false);
    try {
      const current = getSettings();
      let needsRefresh = false;
      if (current.serverBaseUrl !== serverHint) {
        setServerHint(current.serverBaseUrl);
        needsRefresh = true;
      }
      if (current.mode !== runtimeMode) {
        setRuntimeMode(current.mode);
        needsRefresh = true;
      }
      if (needsRefresh) {
        handleRefresh();
      }
    } catch {
      // ignore
    }
  };

  const handleCloseCacheManager = () => {
    setCacheManagerOpen(false);
  };

  const toggleControl = (id: ControlDeviceId) => {
    setControlStates((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const chartLoading = telemetrySource === "mock"
    ? telemetryLoading && !displayTelemetry.length
    : potTelemetryLoading && !displayTelemetry.length;
  const chartError = telemetrySource === "mock" ? telemetryError : potTelemetryError;

  const chartContent = useMemo(() => {
    if (activeChartTab === "plant") {
      if (chartLoading) {
        const message = telemetrySource === "mock"
          ? runtimeMode === "live"
            ? "Loading live sensor telemetry..."
            : "Loading demo telemetry..."
          : `Loading telemetry for ${resolvePotLabel(telemetrySource)}...`;
        return <LoadingState message={message} />;
      }

      if (chartError && !displayTelemetry.length) {
        return <ErrorState message={chartError} onRetry={handleRefresh} />;
      }

      return (
        <TelemetryChart
          data={chartSeries}
          title="Plant Conditions"
          subtitle={plantTelemetrySubtitle}
          actions={telemetryActions}
        />
      );
    }

    if (activeChartTab === "control") {
      return (
        <PlantControlPanel
          states={controlStates}
          onToggle={toggleControl}
          watering={watering}
          onSnapshot={handleSensorSnapshot}
          resolvePotLabel={resolvePotLabel}
          availablePotIds={controlPotIds}
          potIdentities={potIdentities}
          onRename={handleManualRename}
          onRefreshDevices={() => requestHealthRefresh(true)}
          refreshingDevices={healthLoading}
        />
      );
    }

    if (activeChartTab === "local") {
      if (!geolocation.coords) {
        return (
          <LocationPrompt
            status={geolocation.status}
            error={geolocation.error}
            onEnable={geolocation.requestPermission}
          />
        );
      }

      if (localLoading && !localWeather.length) {
        return <LoadingState message="Loading local area conditions..." />;
      }

      if (localError && !localWeather.length) {
        return <ErrorState message={localError} onRetry={refreshLocal} />;
      }

      const coverageLabel = coverageHours ? `Coverage ~${coverageHours.toFixed(1)} hours` : null;
      const stationIdentifier = localStation?.identifier ?? null;
      const stationName = localStation?.name ?? null;
      const baseStationLabel = stationName
        ? stationIdentifier
          ? `${stationName} (${stationIdentifier})`
          : stationName
        : stationIdentifier ?? localLatest?.station ?? null;
      const stationDistance =
        typeof localStation?.distanceKm === "number"
          ? `~${localStation.distanceKm.toFixed(1)} km away`
          : null;
      const subtitleParts = [
        baseStationLabel ? `Nearest station: ${baseStationLabel}` : null,
        stationDistance,
        coverageLabel,
      ].filter(Boolean) as string[];
      const subtitle = subtitleParts.length ? subtitleParts.join(" · ") : "Live observations from public data.";

      return (
        <div className="space-y-4">
          <TelemetryChart data={localWeather} title="Local Area Conditions" subtitle={subtitle} />
          {geolocation.coords ? (
            <LocalConditionsMap
              lat={geolocation.coords.lat}
              lon={geolocation.coords.lon}
              accuracy={geolocation.coords.accuracy}
              station={localStation}
              sources={localSources}
            />
          ) : null}
        </div>
      );
    }

    if (activeChartTab === "diagnostics") {
      return (
        <DiagnosticsPage
          summary={healthSummary}
          mqtt={healthMqtt}
          weather={healthWeather}
          storage={healthStorage}
          events={healthEvents}
          eventsCount={healthEventsCount}
          loading={healthLoading}
          error={healthError}
          onRefresh={refreshHealth}
        />
      );
    }

    return null;
  }, [
    activeChartTab,
    controlStates,
    geolocation.coords,
    geolocation.error,
    geolocation.requestPermission,
    geolocation.status,
    localError,
    localLatest,
    localLoading,
    localWeather,
    localSources,
    refreshLocal,
    displayTelemetry,
    telemetrySource,
    resolvePotLabel,
    telemetryError,
    telemetryLoading,
    chartLoading,
    chartError,
    plantTelemetrySubtitle,
    chartSeries,
    telemetryActions,
    handleRefresh,
    handleSensorSnapshot,
    coverageHours,
    localStation,
    runtimeMode,
    watering,
    healthSummary,
    healthMqtt,
    healthWeather,
    healthStorage,
    healthEvents,
    healthEventsCount,
    healthLoading,
    healthError,
    refreshHealth,
    requestHealthRefresh,
    controlPotIds,
    potIdentities,
    handleManualRename,
  ]);

  return (
    <>
      {namingTarget ? (
        <DeviceNamingPrompt
          device={namingTarget}
          onSubmit={handleNameSubmit}
          onDismiss={handleDismissNamePrompt}
        />
      ) : null}
      <PageShell
      title={title}
      subtitle="Monitor broker connectivity and hub health as we iterate on the UI."
      actions={
        <div className="flex items-center gap-2">
          <ConnectionBadges rest={{ loading, error, data }} events={eventConnectionState} />
          <button
            type="button"
            onClick={handleRefresh}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-[rgba(8,36,24,0.85)] px-3 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/50 hover:bg-[rgba(12,52,32,0.9)]"
          >
            <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-[rgba(8,36,24,0.85)] px-3 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/50 hover:bg-[rgba(12,52,32,0.9)]"
            title="Settings"
          >
            <Cog6ToothIcon className="h-4 w-4" aria-hidden="true" />
            Settings
          </button>
        </div>
      }
    >
      <div className="space-y-12">
        <div className="-mx-6 lg:-mx-12 xl:-mx-20">
          {loading ? (
            <div className="flex min-h-[24rem] w-full items-center justify-center bg-[rgba(6,27,18,0.88)] px-6 py-16 shadow-[0_30px_80px_rgba(6,24,16,0.65)]">
              <div className="flex items-center gap-3 text-emerald-100/80">
                <span className="inline-flex h-4 w-4 animate-ping rounded-full bg-emerald-400/80" />
                <span className="text-base font-semibold tracking-[0.35em] text-emerald-200/80">
                  WAKING THE HUB
                </span>
              </div>
            </div>
          ) : null}
          {!loading && error ? (
            <div className="px-6 lg:px-12 xl:px-20">
              <ErrorState message={error} onRetry={handleRefresh} />
            </div>
          ) : null}
          {!loading && data ? <HubHeroTile info={data} /> : null}
        </div>

        {!loading ? (
          <div className="px-6 lg:px-12 xl:px-20 mt-6">
            <StatusBar
              summary={healthSummary}
              mqtt={healthMqtt}
              weather={healthWeather}
              loading={loading || healthLoading}
              error={healthError ?? error}
              onHandleCache={() => setCacheManagerOpen(true)}
            />
          </div>
        ) : null}

        {!loading && data ? (
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-700/40 bg-[rgba(6,27,18,0.75)] p-2 text-sm font-medium text-emerald-200/80 shadow-inner shadow-emerald-950/60">
              <div className="inline-flex rounded-xl border border-emerald-500/30 bg-[rgba(9,39,25,0.65)] p-1">
                <TabButton
                  label="Plant Conditions"
                  isActive={activeChartTab === "plant"}
                  onClick={() => setActiveChartTab("plant")}
                />
                <TabButton
                  label="Plant Control"
                  isActive={activeChartTab === "control"}
                  onClick={() => setActiveChartTab("control")}
                />
                <TabButton
                  label="Local Area Conditions"
                  isActive={activeChartTab === "local"}
                  onClick={() => setActiveChartTab("local")}
                />
                <TabButton
                  label="My Plants"
                  isActive={activeChartTab === "myplants"}
                  onClick={() => setActiveChartTab("myplants")}
                />
                <TabButton
                  label="Diagnostics"
                  isActive={activeChartTab === "diagnostics"}
                  onClick={() => setActiveChartTab("diagnostics")}
                />
              </div>
              {activeChartTab === "plant" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <TelemetrySourceSelector
                    value={telemetrySource}
                    options={telemetryOptions}
                    onChange={setTelemetrySource}
                  />
                  <TelemetryRangeSelector
                    value={telemetryRangeKey}
                    options={TELEMETRY_RANGE_PRESETS}
                    onChange={setTelemetryRangeKey}
                    disabled={telemetrySource === "mock"}
                  />
                </div>
              ) : null}
              {activeChartTab === "local" && geolocation.coords ? (
                <LocalRangeSelector
                  value={localRange}
                  options={availableRangeOptions as LocalRange[]}
                  onChange={setLocalRange}
                />
              ) : null}
            </div>
            {activeChartTab === "myplants" ? <MyPlantsTab /> : chartContent}

            {activeChartTab === "plant" ? (
              <>
                <TelemetrySummary latest={displayLatest} />
                <WaterModelSection plantId={telemetrySource === "mock" ? undefined : telemetrySource} />
                <div className="grid gap-6 lg:grid-cols-3">
                  <div className="space-y-6 lg:col-span-2">
                    <MqttDiagnostics info={data} />
                    <TelemetryTable
                      data={displayTelemetry}
                      rangeLabel={telemetrySource === "mock" ? undefined : potTelemetryRangeLabel}
                    />
                  </div>
                  <CorsOriginsCard origins={data.cors_origins} />
                </div>
              </>
            ) : activeChartTab === "local" && geolocation.coords ? (
              <div className="grid gap-6">
                <CollapsibleTile
                  id="local-conditions-latest-observation"
                  title="Latest Local Forecast"
                  subtitle={localLatestSubtitle}
                  className="text-sm text-emerald-100/90"
                  bodyClassName="mt-4 space-y-2 text-emerald-100"
                  titleClassName="text-base font-semibold text-emerald-50"
                  subtitleClassName="text-xs text-emerald-200/70"
                >
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 font-semibold uppercase tracking-wide text-sky-100/90">
                        NOAA HRRR Forecast
                      </span>
                      {localHrrrError ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 font-semibold uppercase tracking-wide text-amber-100/90">
                          History warning: {localHrrrError}
                        </span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => refreshLocal()}
                      disabled={localLoading}
                      className="inline-flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-1 font-semibold text-sky-100 transition hover:border-sky-400/60 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {localLoading ? "Refreshing..." : "Refresh"}
                    </button>
                  </div>
                  {localLoading && !localLatest ? (
                    <LoadingState message="Loading latest forecast..." />
                  ) : localError && !localLatest ? (
                    <ErrorState message={localError} onRetry={refreshLocal} />
                  ) : localLatest ? (
                    <>
                      {localError ? (
                        <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
                          Latest refresh warning: {localError}
                        </div>
                      ) : null}
                      <ul className="space-y-1">
                        <li>Valid Time: {formatIsoTimestamp(localLatest.timestamp ?? null)}</li>
                        <li>Temperature: {formatMaybeNumber(localLatest.temperature_c, 1)} deg C</li>
                        <li>Humidity: {formatMaybeNumber(localLatest.humidity_pct, 1)} %</li>
                        <li>Pressure: {formatMaybeNumber(localLatest.pressure_hpa, 1)} hPa</li>
                        <li>Solar Radiation: {formatMaybeNumber(localLatest.solar_radiation_w_m2, 1)} W/m^2</li>
                        <li>Wind Speed: {formatMaybeNumber(localLatest.wind_speed_m_s, 2)} m/s</li>
                        <li>Data Sources: {latestSourceDisplay ?? "-"}</li>
                      </ul>
                    </>
                  ) : (
                    <p className="text-sm text-emerald-200/80">
                      No recent HRRR data available. Try refreshing or adjust the time window.
                    </p>
                  )}
                </CollapsibleTile>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </PageShell>
    <CacheManagerPanel open={cacheManagerOpen} onClose={handleCloseCacheManager} onChanged={refreshHealth} />
    <SettingsPanel open={settingsOpen} onClose={handleCloseSettings} />
    </>
  );
}

function PlantControlPanel({
  states,
  onToggle,
  watering,
  onSnapshot,
  resolvePotLabel,
  availablePotIds,
  potIdentities,
  onRename,
  onRefreshDevices,
  refreshingDevices,
}: {
  states: ControlStates;
  onToggle: (id: ControlDeviceId) => void;
  watering: WateringRecommendationState;
  onSnapshot: (payload: SensorReadPayload) => void;
  resolvePotLabel: (potId: string) => string;
  availablePotIds: string[];
  potIdentities: Record<string, DeviceIdentity>;
  onRename: (potId: string, deviceName: string) => Promise<unknown>;
  onRefreshDevices: () => void;
  refreshingDevices: boolean;
}) {
  const persistedControlPotSelection = useMemo(() => loadPersistedControlPotSelection(), []);
  const [selectedPotId, setSelectedPotId] = useState(() => persistedControlPotSelection.selectedPotId ?? "");
  const trimmedPotId = selectedPotId.trim().toLowerCase();
  const sensorRead = useSensorRead();
  const pumpStatusMap = useEventStore(selectPumpStatus);
  const connectedPotIds = useMemo(
    () =>
      Array.from(new Set(availablePotIds.map((id) => id.trim().toLowerCase()).filter((id) => id.length > 0))).sort(
        (a, b) => a.localeCompare(b)
      ),
    [availablePotIds]
  );
  const {
    isOn: pumpIsOn,
    pending: pumpPending,
    requestId: pumpRequestId,
    lastConfirmedAt: pumpLastConfirmedAt,
    feedback: pumpFeedback,
    clearFeedback: clearPumpFeedback,
    toggle: togglePump,
    syncTelemetry: syncPumpTelemetry,
  } = usePumpControl(undefined, trimmedPotId);
  const {
    isOn: fanIsOn,
    pending: fanPending,
    requestId: fanRequestId,
    lastConfirmedAt: fanLastConfirmedAt,
    feedback: fanFeedback,
    clearFeedback: clearFanFeedback,
    toggle: toggleFan,
    syncTelemetry: syncFanTelemetry,
  } = useFanControl(undefined, trimmedPotId);
  const {
    isOn: misterIsOn,
    pending: misterPending,
    requestId: misterRequestId,
    lastConfirmedAt: misterLastConfirmedAt,
    feedback: misterFeedback,
    clearFeedback: clearMisterFeedback,
    toggle: toggleMister,
    syncTelemetry: syncMisterTelemetry,
  } = useMisterControl(undefined, trimmedPotId);
  const {
    isOn: lightIsOn,
    pending: lightPending,
    requestId: lightRequestId,
    lastConfirmedAt: lightLastConfirmedAt,
    feedback: lightFeedback,
    clearFeedback: clearLightFeedback,
    toggle: toggleLight,
    syncTelemetry: syncLightTelemetry,
  } = useLightControl(undefined, trimmedPotId);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const lastRequestIdRef = useRef<string | null>(null);
  const lastPotIdRef = useRef<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameFeedback, setRenameFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const activeIdentity = potIdentities[trimmedPotId];
  const [sensorModeValue, setSensorModeValue] = useState<"full" | "control_only">("full");
  const [sensorModeFeedback, setSensorModeFeedback] = useState<{ type: "success" | "error"; message: string } | null>(
    null
  );
  const [sensorModeSaving, setSensorModeSaving] = useState(false);
  const [useCustomPotId, setUseCustomPotId] = useState(() => persistedControlPotSelection.useCustomPotId ?? false);
  const [customPotId, setCustomPotId] = useState(() => persistedControlPotSelection.customPotId ?? "");
  const connectedPotIdSet = useMemo(() => new Set(connectedPotIds), [connectedPotIds]);
  const controlPotSelectValue = useMemo(() => {
    if (!connectedPotIds.length || useCustomPotId) {
      return "__custom__";
    }
    if (connectedPotIdSet.has(trimmedPotId)) {
      return trimmedPotId;
    }
    return connectedPotIds[0] ?? "__custom__";
  }, [connectedPotIdSet, connectedPotIds, trimmedPotId, useCustomPotId]);
  const activeStatus = trimmedPotId ? pumpStatusMap[trimmedPotId] : null;
  const selectedPotLabel = trimmedPotId ? resolvePotLabel(trimmedPotId) : null;

  const describeWaterLow = (value: boolean | null | undefined) => {
    if (value === true) return "Reservoir low";
    if (value === false) return "Reservoir OK";
    return "Unknown";
  };

  const describeWaterCutoff = (value: boolean | null | undefined) => {
    if (value === true) return "Cutoff triggered";
    if (value === false) return "Cutoff OK";
    return "Unknown";
  };

  const snapshotTimestampLabel = (timestamp: string | null | undefined, timestampMs: number | null | undefined) => {
    if (typeof timestamp === "string" && timestamp.trim()) {
      const parsed = new Date(timestamp);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleString();
      }
    }
    if (timestampMs !== null && timestampMs !== undefined) {
      const parsed = new Date(timestampMs);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleString();
      }
    }
    return null;
  };

  const applyUnit = (value: string, unit: string) => (value === "-" ? "-" : `${value} ${unit}`);

  useEffect(() => {
    if (sensorRead.error) {
      setFeedback({ type: "error", message: sensorRead.error });
    }
  }, [sensorRead.error]);

  useEffect(() => {
    if (lastPotIdRef.current === trimmedPotId) {
      return;
    }
    lastPotIdRef.current = trimmedPotId;
    sensorRead.reset();
    setFeedback(null);
    setRenameFeedback(null);
    setSensorModeFeedback(null);
    clearPumpFeedback();
    clearFanFeedback();
    clearMisterFeedback();
    clearLightFeedback();
  }, [
    trimmedPotId,
    sensorRead.reset,
    clearPumpFeedback,
    clearFanFeedback,
    clearMisterFeedback,
    clearLightFeedback,
  ]);

  useEffect(() => {
    if (!trimmedPotId) {
      setRenameValue("");
      return;
    }
    setRenameValue(activeIdentity?.deviceName ?? "");
  }, [trimmedPotId, activeIdentity?.deviceName]);

  useEffect(() => {
    if (!trimmedPotId) {
      setSensorModeValue("full");
      return;
    }
    const mode = activeStatus?.sensorMode;
    if (mode === "control_only" || mode === "full") {
      setSensorModeValue(mode);
    }
  }, [activeStatus?.sensorMode, trimmedPotId]);

  useEffect(() => {
    if (useCustomPotId) {
      return;
    }
    if (!connectedPotIds.length) {
      return;
    }
    const normalized = selectedPotId.trim().toLowerCase();
    if (!normalized || !connectedPotIdSet.has(normalized)) {
      setSelectedPotId(connectedPotIds[0]);
    }
  }, [connectedPotIdSet, connectedPotIds, selectedPotId, useCustomPotId]);

  useEffect(() => {
    if (!useCustomPotId) {
      return;
    }
    const normalized = customPotId.trim().toLowerCase();
    if (normalized !== selectedPotId) {
      setSelectedPotId(normalized);
    }
  }, [customPotId, selectedPotId, useCustomPotId]);

  useEffect(() => {
    persistControlPotSelection({
      selectedPotId: selectedPotId.trim().toLowerCase(),
      useCustomPotId,
      customPotId,
    });
  }, [selectedPotId, useCustomPotId, customPotId]);

  const handleControlPotChange = useCallback(
    (value: string) => {
      if (value === "__custom__") {
        setUseCustomPotId(true);
        setSelectedPotId(customPotId.trim().toLowerCase());
        return;
      }
      setUseCustomPotId(false);
      setSelectedPotId(value.trim().toLowerCase());
    },
    [customPotId]
  );

  useEffect(() => {
    if (sensorRead.requestId && sensorRead.data && !sensorRead.loading) {
      if (lastRequestIdRef.current !== sensorRead.requestId) {
        lastRequestIdRef.current = sensorRead.requestId;
        const fallbackPotId = (sensorRead.data.potId || trimmedPotId || "").trim() || "unknown-pot";
        const payload: SensorReadPayload = {
          ...sensorRead.data,
          potId: fallbackPotId,
        };
        onSnapshot(payload);
        const label = snapshotTimestampLabel(payload.timestamp, payload.timestampMs ?? null);
        setFeedback({
          type: "success",
          message: label ? `Snapshot captured ${label}.` : "Snapshot captured.",
        });
      }
    }
  }, [trimmedPotId, onSnapshot, sensorRead.data, sensorRead.loading, sensorRead.requestId]);

  useEffect(() => {
    if (!feedback) {
      return;
    }
    const timer = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!pumpFeedback) {
      return;
    }
    const timer = setTimeout(() => clearPumpFeedback(), 5000);
    return () => clearTimeout(timer);
  }, [pumpFeedback, clearPumpFeedback]);
  useEffect(() => {
    if (!fanFeedback) {
      return;
    }
    const timer = setTimeout(() => clearFanFeedback(), 5000);
    return () => clearTimeout(timer);
  }, [fanFeedback, clearFanFeedback]);
  useEffect(() => {
    if (!misterFeedback) {
      return;
    }
    const timer = setTimeout(() => clearMisterFeedback(), 5000);
    return () => clearTimeout(timer);
  }, [misterFeedback, clearMisterFeedback]);
  useEffect(() => {
    if (!lightFeedback) {
      return;
    }
    const timer = setTimeout(() => clearLightFeedback(), 5000);
    return () => clearTimeout(timer);
  }, [lightFeedback, clearLightFeedback]);

  const handleSensorSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedPotId) {
      setFeedback({
        type: "error",
        message: "Select a control pot before requesting a sensor read.",
      });
      return;
    }
    setFeedback(null);
    await sensorRead.request({ potId: trimmedPotId });
  };

  const handleRenameSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedPotId) {
      setRenameFeedback({ type: "error", message: "Select a control pot before renaming." });
      return;
    }
    const nextName = renameValue.trim();
    if (!nextName) {
      setRenameFeedback({ type: "error", message: "Enter a display name before saving." });
      return;
    }
    setRenameSaving(true);
    setRenameFeedback(null);
    try {
      await onRename(trimmedPotId, nextName);
      setRenameFeedback({ type: "success", message: "Display name updated." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update display name.";
      setRenameFeedback({ type: "error", message });
    } finally {
      setRenameSaving(false);
    }
  };

  const handleSensorModeSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedPotId) {
      return;
    }
    setSensorModeSaving(true);
    setSensorModeFeedback(null);
    try {
      await updateSensorMode(trimmedPotId, { sensorMode: sensorModeValue, timeout: 10 });
      setSensorModeFeedback({ type: "success", message: "Sensor mode updated." });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update sensor mode.";
      setSensorModeFeedback({ type: "error", message });
    } finally {
      setSensorModeSaving(false);
    }
  };

  const sensorSnapshot = sensorRead.data;
  useEffect(() => {
    if (!sensorSnapshot) {
      return;
    }
    const payload = {
      ...sensorSnapshot,
      requestId: sensorRead.requestId ?? null,
    };
    syncPumpTelemetry(payload);
    syncFanTelemetry(payload);
    syncMisterTelemetry(payload);
    syncLightTelemetry(payload);
  }, [
    sensorSnapshot,
    sensorRead.requestId,
    syncPumpTelemetry,
    syncFanTelemetry,
    syncMisterTelemetry,
    syncLightTelemetry,
  ]);

  useEffect(() => {
    if (!trimmedPotId) {
      return;
    }
    const status = pumpStatusMap[trimmedPotId];
    if (!status) {
      return;
    }
    if (typeof status.pumpOn === "boolean") {
      syncPumpTelemetry({
        valveOpen: status.pumpOn,
        timestamp: status.timestamp ?? null,
        timestampMs: status.timestampMs ?? null,
        requestId: status.requestId ?? null,
      });
    }
    if (typeof status.fanOn === "boolean") {
      syncFanTelemetry({
        fanOn: status.fanOn,
        timestamp: status.timestamp ?? null,
        timestampMs: status.timestampMs ?? null,
        requestId: status.requestId ?? null,
      });
    }
    if (typeof status.misterOn === "boolean") {
      syncMisterTelemetry({
        misterOn: status.misterOn,
        timestamp: status.timestamp ?? null,
        timestampMs: status.timestampMs ?? null,
        requestId: status.requestId ?? null,
      });
    }
    if (typeof status.lightOn === "boolean") {
      syncLightTelemetry({
        lightOn: status.lightOn,
        timestamp: status.timestamp ?? null,
        timestampMs: status.timestampMs ?? null,
        requestId: status.requestId ?? null,
      });
    }
  }, [pumpStatusMap, syncPumpTelemetry, syncFanTelemetry, syncMisterTelemetry, syncLightTelemetry, trimmedPotId]);

  const isSubmitDisabled = sensorRead.loading || !trimmedPotId;
  const snapshotTimestamp = sensorSnapshot
    ? snapshotTimestampLabel(sensorSnapshot.timestamp, sensorSnapshot.timestampMs ?? null)
    : null;

  const moistureValue = formatMaybeNumber(sensorSnapshot?.moisture ?? NaN, 1);
  const temperatureValue = formatMaybeNumber(sensorSnapshot?.temperature ?? NaN, 1);
  const humidityValue = formatMaybeNumber(sensorSnapshot?.humidity ?? NaN, 1);
  const flowRateValue = formatMaybeNumber(sensorSnapshot?.flowRateLpm ?? NaN, 2);
  const valveDisplay = typeof sensorSnapshot?.valveOpen === "boolean"
    ? sensorSnapshot.valveOpen
      ? "Open"
      : "Closed"
    : "Unknown";
  const fanDisplay = typeof sensorSnapshot?.fanOn === "boolean"
    ? sensorSnapshot.fanOn
      ? "On"
      : "Off"
    : "Unknown";
  const misterDisplay = typeof sensorSnapshot?.misterOn === "boolean"
    ? sensorSnapshot.misterOn
      ? "On"
      : "Off"
    : "Unknown";
  const lightDisplay = typeof sensorSnapshot?.lightOn === "boolean"
    ? sensorSnapshot.lightOn
      ? "On"
      : "Off"
    : "Unknown";
  const soilRawDisplay =
    sensorSnapshot && typeof sensorSnapshot.soilRaw === "number" && !Number.isNaN(sensorSnapshot.soilRaw)
      ? sensorSnapshot.soilRaw.toString()
      : "-";
  const reservoirDisplay = describeWaterLow(sensorSnapshot?.waterLow);
  const cutoffDisplay = describeWaterCutoff(sensorSnapshot?.waterCutoff);
  const potIdDisplay = sensorSnapshot?.potId ? sensorSnapshot.potId : null;
  const pumpStatusLabel = pumpPending
    ? "Pending"
    : pumpIsOn === null
      ? "Unknown"
      : pumpIsOn
        ? "On"
        : "Off";
  const pumpHelper = (() => {
    if (!trimmedPotId) {
      return "Select a control pot above to enable pump control.";
    }
    if (pumpPending) {
      return "Awaiting confirmation from the hub...";
    }
    if (pumpLastConfirmedAt) {
      return pumpRequestId
        ? `Last confirmed ${pumpLastConfirmedAt} · Request ${pumpRequestId}`
        : `Last confirmed ${pumpLastConfirmedAt}`;
    }
    return "Tap to toggle the pump.";
  })();
  const pumpButtonDisabled = !trimmedPotId || pumpPending;
  const handlePumpToggle = useCallback(() => {
    void togglePump({ potId: trimmedPotId });
  }, [togglePump, trimmedPotId]);

  const fanStatusLabel = fanPending
    ? "Pending"
    : fanIsOn === null
      ? "Unknown"
      : fanIsOn
        ? "On"
        : "Off";
  const fanHelper = (() => {
    if (!trimmedPotId) {
      return "Select a control pot above to enable fan control.";
    }
    if (fanPending) {
      return "Awaiting confirmation from the hub...";
    }
    if (fanLastConfirmedAt) {
      return fanRequestId
        ? `Last confirmed ${fanLastConfirmedAt} · Request ${fanRequestId}`
        : `Last confirmed ${fanLastConfirmedAt}`;
    }
    return "Tap to toggle the fan.";
  })();
  const fanButtonDisabled = !trimmedPotId || fanPending;
  const handleFanToggle = useCallback(() => {
    void toggleFan({ potId: trimmedPotId });
  }, [toggleFan, trimmedPotId]);

  const misterStatusLabel = misterPending
    ? "Pending"
    : misterIsOn === null
      ? "Unknown"
      : misterIsOn
        ? "On"
        : "Off";
  const misterHelper = (() => {
    if (!trimmedPotId) {
      return "Select a control pot above to enable mister control.";
    }
    if (misterPending) {
      return "Awaiting confirmation from the hub...";
    }
    if (misterLastConfirmedAt) {
      return misterRequestId
        ? `Last confirmed ${misterLastConfirmedAt} - Request ${misterRequestId}`
        : `Last confirmed ${misterLastConfirmedAt}`;
    }
    return "Tap to toggle the mister.";
  })();
  const misterButtonDisabled = !trimmedPotId || misterPending;
  const handleMisterToggle = useCallback(() => {
    void toggleMister({ potId: trimmedPotId });
  }, [toggleMister, trimmedPotId]);

  const lightStatusLabel = lightPending
    ? "Pending"
    : lightIsOn === null
      ? "Unknown"
      : lightIsOn
        ? "On"
        : "Off";
  const lightHelper = (() => {
    if (!trimmedPotId) {
      return "Select a control pot above to enable grow light control.";
    }
    if (lightPending) {
      return "Awaiting confirmation from the hub...";
    }
    if (lightLastConfirmedAt) {
      return lightRequestId
        ? `Last confirmed ${lightLastConfirmedAt} - Request ${lightRequestId}`
        : `Last confirmed ${lightLastConfirmedAt}`;
    }
    return "Tap to toggle the grow light.";
  })();
  const lightButtonDisabled = !trimmedPotId || lightPending;
  const handleLightToggle = useCallback(() => {
    void toggleLight({ potId: trimmedPotId });
  }, [toggleLight, trimmedPotId]);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-700/40 bg-[rgba(6,27,18,0.75)] p-4 text-sm text-emerald-100/85 shadow-inner shadow-emerald-950/40">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[16rem] flex-col gap-1 text-xs text-emerald-200/70">
              Control Pot
              <select
                value={controlPotSelectValue}
                onChange={(event) => handleControlPotChange(event.target.value)}
                className="min-w-[14rem] rounded-lg border border-emerald-700/50 bg-[rgba(6,30,20,0.88)] px-3 py-2 text-sm text-emerald-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
              >
                {connectedPotIds.map((potId) => {
                  const label = resolvePotLabel(potId);
                  const optionLabel = label.toLowerCase() === potId ? potId : `${label} (${potId})`;
                  return (
                    <option key={potId} value={potId}>
                      {optionLabel}
                    </option>
                  );
                })}
                <option value="__custom__">Custom pot id...</option>
              </select>
            </label>
            {!connectedPotIds.length || useCustomPotId ? (
              <label className="flex min-w-[14rem] flex-col gap-1 text-xs text-emerald-200/70">
                Custom Pot ID
                <input
                  type="text"
                  value={customPotId}
                  onChange={(event) => {
                    setUseCustomPotId(true);
                    setCustomPotId(event.target.value);
                    setSelectedPotId(event.target.value.trim().toLowerCase());
                  }}
                  placeholder="e.g. pot-1"
                  className="rounded-lg border border-emerald-700/50 bg-[rgba(6,30,20,0.88)] px-3 py-2 text-sm text-emerald-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
                />
              </label>
            ) : null}
          </div>
          <p className="max-w-md text-xs text-emerald-200/70">
            {selectedPotLabel
              ? `Plant Control actions and schedule apply to ${selectedPotLabel}.`
              : "Select a pot to enable schedule and manual controls."}
          </p>
        </div>
      </div>
      <WateringRecommendationCard
        recommendation={watering.data}
        loading={watering.loading}
        error={watering.error}
        onRetry={watering.refresh}
        potId={trimmedPotId || null}
        potLabel={selectedPotLabel}
      />
      <PenmanMonteithEquation recommendation={watering.data} />
      <CollapsibleTile
        id="plant-control-manual-controls"
        title="Manual Controls"
        subtitle="Manual overrides send live commands to the hub. Only outputs supported by your pot will respond."
        className="p-4 text-sm text-emerald-100/85"
        bodyClassName="mt-4 space-y-4"
      >
        <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={handleSensorSubmit}>
          <button
            type="submit"
            title="Send an on-demand sensor_read command to the hub"
            disabled={isSubmitDisabled}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${
              isSubmitDisabled
                ? "cursor-not-allowed border border-emerald-800/40 bg-[rgba(6,24,16,0.6)] text-emerald-200/40"
                : "border border-emerald-500/70 bg-emerald-500/15 text-emerald-50 hover:border-emerald-400 hover:bg-emerald-500/25"
            }`}
          >
            {sensorRead.loading ? (
              <>
                <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
                Requesting...
              </>
              ) : (
                "Sensor Read"
              )}
          </button>
          <button
            type="button"
            onClick={onRefreshDevices}
            disabled={refreshingDevices}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${
              refreshingDevices
                ? "cursor-not-allowed border border-emerald-800/40 bg-[rgba(6,24,16,0.6)] text-emerald-200/40"
                : "border border-emerald-500/70 bg-emerald-500/15 text-emerald-50 hover:border-emerald-400 hover:bg-emerald-500/25"
            }`}
          >
            <ArrowPathIcon className={`h-4 w-4 ${refreshingDevices ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh devices
          </button>
        </form>
        <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={handleRenameSubmit}>
          <label className="flex flex-col text-xs text-emerald-200/70 sm:text-right">
            Display name
            <input
              type="text"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder={trimmedPotId ? "e.g. Kitchen Basil" : "Select a control pot first"}
              disabled={renameSaving || !trimmedPotId}
              maxLength={32}
              className="mt-1 min-w-[12rem] rounded-lg border border-emerald-700/50 bg-[rgba(6,30,20,0.88)] px-3 py-2 text-sm text-emerald-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          <button
            type="submit"
            disabled={renameSaving || !trimmedPotId}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${
              renameSaving || !trimmedPotId
                ? "cursor-not-allowed border border-emerald-800/40 bg-[rgba(6,24,16,0.6)] text-emerald-200/40"
                : "border border-emerald-500/70 bg-emerald-500/15 text-emerald-50 hover:border-emerald-400 hover:bg-emerald-500/25"
            }`}
          >
            {renameSaving ? "Saving..." : "Save name"}
          </button>
        </form>
        <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={handleSensorModeSubmit}>
          <label className="flex flex-col text-xs text-emerald-200/70 sm:text-right">
            Sensor mode
            <select
              value={sensorModeValue}
              onChange={(event) => setSensorModeValue(event.target.value as "full" | "control_only")}
              disabled={sensorModeSaving || !trimmedPotId}
              className="mt-1 min-w-[12rem] rounded-lg border border-emerald-700/50 bg-[rgba(6,30,20,0.88)] px-3 py-2 text-sm text-emerald-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="full">Full sensors (cutoff enforced)</option>
              <option value="control_only">Control-only (no sensors)</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={sensorModeSaving || !trimmedPotId}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${
              sensorModeSaving || !trimmedPotId
                ? "cursor-not-allowed border border-emerald-800/40 bg-[rgba(6,24,16,0.6)] text-emerald-200/40"
                : "border border-emerald-500/70 bg-emerald-500/15 text-emerald-50 hover:border-emerald-400 hover:bg-emerald-500/25"
            }`}
          >
            {sensorModeSaving ? "Saving..." : "Save mode"}
          </button>
        </form>
        {sensorModeValue === "control_only" ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
            Control-only disables sensor reads and safety cutoff checks. Use with caution.
          </div>
        ) : null}
          {feedback ? (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-xs ${
                feedback.type === "success"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                  : "border-rose-500/50 bg-rose-500/10 text-rose-200"
              }`}
            >
              {feedback.message}
            </div>
          ) : null}
          {renameFeedback ? (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-xs ${
                renameFeedback.type === "success"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                  : "border-rose-500/50 bg-rose-500/10 text-rose-200"
              }`}
            >
              {renameFeedback.message}
            </div>
          ) : null}
          {sensorModeFeedback ? (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-xs ${
                sensorModeFeedback.type === "success"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                  : "border-rose-500/50 bg-rose-500/10 text-rose-200"
              }`}
            >
              {sensorModeFeedback.message}
            </div>
          ) : null}
        {pumpFeedback ? (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-xs ${
                pumpFeedback.type === "success"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                : pumpFeedback.type === "error"
                  ? "border-rose-500/50 bg-rose-500/10 text-rose-200"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200/80"
              }`}
            >
              {pumpFeedback.message}
            </div>
          ) : null}
          {fanFeedback ? (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-xs ${
                fanFeedback.type === "success"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                : fanFeedback.type === "error"
                  ? "border-rose-500/50 bg-rose-500/10 text-rose-200"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200/80"
              }`}
            >
              {fanFeedback.message}
            </div>
          ) : null}
          {misterFeedback ? (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-xs ${
                misterFeedback.type === "success"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                  : misterFeedback.type === "error"
                    ? "border-rose-500/50 bg-rose-500/10 text-rose-200"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200/80"
              }`}
            >
              {misterFeedback.message}
            </div>
          ) : null}
          {lightFeedback ? (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-xs ${
                lightFeedback.type === "success"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                  : lightFeedback.type === "error"
                    ? "border-rose-500/50 bg-rose-500/10 text-rose-200"
                    : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200/80"
              }`}
            >
              {lightFeedback.message}
            </div>
          ) : null}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {CONTROL_DEVICES.map((device) => {
              if (device.id === "pump") {
                return (
                  <ControlToggleButton
                    key={device.id}
                    label={device.label}
                    isOn={pumpIsOn ?? false}
                    status={pumpStatusLabel}
                    helper={pumpHelper}
                    disabled={pumpButtonDisabled}
                    onClick={handlePumpToggle}
                  />
                );
              }
              if (device.id === "fan") {
                return (
                  <ControlToggleButton
                    key={device.id}
                    label={device.label}
                    isOn={fanIsOn ?? false}
                    status={fanStatusLabel}
                    helper={fanHelper}
                    disabled={fanButtonDisabled}
                    onClick={handleFanToggle}
                  />
                );
              }
              if (device.id === "mister") {
                return (
                  <ControlToggleButton
                    key={device.id}
                    label={device.label}
                    isOn={misterIsOn ?? false}
                    status={misterStatusLabel}
                    helper={misterHelper}
                    disabled={misterButtonDisabled}
                    onClick={handleMisterToggle}
                  />
                );
              }
              if (device.id === "light") {
                return (
                  <ControlToggleButton
                    key={device.id}
                    label={device.label}
                    isOn={lightIsOn ?? false}
                    status={lightStatusLabel}
                    helper={lightHelper}
                    disabled={lightButtonDisabled}
                    onClick={handleLightToggle}
                  />
                );
              }
              return (
                <ControlToggleButton
                  key={device.id}
                  label={device.label}
                  isOn={states[device.id]}
                  onClick={() => onToggle(device.id)}
                />
              );
            })}
            <div className="rounded-2xl border border-emerald-800/40 bg-[rgba(5,23,16,0.82)] p-4 text-xs text-emerald-100/80 shadow-inner shadow-emerald-950/40 sm:col-span-2 xl:col-span-3">
              <h4 className="text-sm font-semibold text-emerald-50">Sensor Snapshot</h4>
              {sensorSnapshot ? (
                <>
                  <dl className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Soil moisture</dt>
                      <dd className="text-sm text-emerald-100">{applyUnit(moistureValue, "%")}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Temperature</dt>
                      <dd className="text-sm text-emerald-100">{applyUnit(temperatureValue, "deg C")}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Humidity</dt>
                      <dd className="text-sm text-emerald-100">{applyUnit(humidityValue, "%")}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Flow rate</dt>
                      <dd className="text-sm text-emerald-100">{applyUnit(flowRateValue, "L/min")}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Valve</dt>
                      <dd className="text-sm text-emerald-100">{valveDisplay}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Fan</dt>
                      <dd className="text-sm text-emerald-100">{fanDisplay}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Mister</dt>
                      <dd className="text-sm text-emerald-100">{misterDisplay}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Grow Light</dt>
                      <dd className="text-sm text-emerald-100">{lightDisplay}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Reservoir float</dt>
                      <dd className="text-sm text-emerald-100">{reservoirDisplay}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Cutoff float</dt>
                      <dd className="text-sm text-emerald-100">{cutoffDisplay}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Soil raw reading</dt>
                      <dd className="text-sm text-emerald-100">{soilRawDisplay}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-[11px] text-emerald-200/60">
                    {snapshotTimestamp ? `Received ${snapshotTimestamp}` : "Timestamp unavailable"}
                    {sensorRead.requestId ? ` - Request ${sensorRead.requestId}` : ""}
                    {potIdDisplay ? ` - Pot ${potIdDisplay}` : ""}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-xs text-emerald-200/60">
                  No on-demand snapshot yet. Select a control pot and press Sensor Read to fetch one.
                </p>
              )}
          </div>
        </div>
      </CollapsibleTile>
    </div>
  );
}
function ControlToggleButton({
  label,
  isOn,
  onClick,
  disabled = false,
  status,
  helper,
}: {
  label: string;
  isOn: boolean;
  onClick: () => void;
  disabled?: boolean;
  status?: string;
  helper?: string;
}) {
  const active = isOn;
  const statusText = status ?? (active ? "On" : "Off");
  const helperText = helper ?? (active ? "Manual override engaged" : "Tap to enable manual control");
  const buttonClasses = active
    ? "border-emerald-400/80 bg-emerald-500/20 text-emerald-100 shadow shadow-emerald-900/40 hover:border-emerald-300"
    : "border-emerald-900/40 bg-[rgba(7,28,19,0.72)] text-emerald-100/70 hover:border-emerald-700/40 hover:text-emerald-100";
  const statusClasses = active
    ? "border border-emerald-400/60 bg-emerald-500/20 text-emerald-100"
    : "border border-emerald-800/40 bg-[rgba(6,24,16,0.78)] text-emerald-200/60";
  const helperClasses = disabled ? "text-emerald-200/50" : active ? "text-emerald-200/80" : "text-emerald-200/60";
  const disabledClasses = disabled ? "cursor-not-allowed opacity-60" : "";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-28 flex-col justify-between rounded-xl border px-4 py-3 text-left transition-colors ${buttonClasses} ${disabledClasses}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-base font-semibold">{label}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClasses} ${disabled ? "opacity-70" : ""}`}>
          {statusText}
        </span>
      </div>
      <p className={`text-xs ${helperClasses}`}>{helperText}</p>
    </button>
  );
}

function TabButton({
  label,
  isActive,
  onClick,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-4 py-2 transition ${
        isActive
          ? "border border-emerald-400/50 bg-[rgba(12,52,32,0.85)] text-emerald-50 shadow-lg shadow-emerald-950/50"
          : "border border-transparent text-emerald-200/60 hover:border-emerald-500/40 hover:text-emerald-100"
      }`}
    >
      {label}
    </button>
  );
}




