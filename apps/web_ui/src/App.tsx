import { ArrowDownTrayIcon, ArrowPathIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import { Capacitor } from "@capacitor/core";
import { HomeIcon, Squares2X2Icon, WrenchScrewdriverIcon, WifiIcon } from "@heroicons/react/24/outline";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHubInfo } from "./hooks/useHubInfo";
import { useGeolocation } from "./hooks/useGeolocation";
import { useHubWeatherLocation } from "./hooks/useHubWeatherLocation";
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
import { useIcZone1Control } from "./hooks/useIcZone1Control";
import { usePumpControl } from "./hooks/usePumpControl";
import { useFanControl } from "./hooks/useFanControl";
import { useMisterControl } from "./hooks/useMisterControl";
import { useLightControl } from "./hooks/useLightControl";
import {
  type HealthSummary,
  type MqttHealth,
  TelemetrySample,
  SensorReadPayload,
  type WeatherCacheHealth,
  exportPotTelemetry,
  fetchFleetHubAudit,
  fetchFleetHubSummary,
  fetchPotTelemetry,
  type HubInfo,
  queueFleetHubRollback,
  queueFleetHubUpdate,
  updateDeviceName,
  updateSensorMode,
} from "./api/hubClient";
import { useHealthDiagnostics } from "./hooks/useHealthDiagnostics";
import { DiagnosticsPage } from "./pages/DiagnosticsPage";
import {
  getApiTargetLabelSync,
  getActiveUserIdSync,
  getAuthTokenSync,
  getSettings,
  setSettings,
  type EffectiveAccessSnapshot,
  type RuntimeMode,
  type UiSettings,
} from "./settings";
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
const CONTROL_DURATION_STORAGE_KEY = "projectplant:plant-control:manual-duration-sec:v1";

const CONTROL_DEVICES = [
  { id: "ic_zone1", label: "IC Zone 1" },
  { id: "pump", label: "Pump" },
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
const LIVE_ONLY_TABS: HubTab[] = ["control", "local", "myplants", "diagnostics"];
const LIVE_ONLY_TAB_REASON = "Live mode required. Open Settings to connect to your hub.";
const DEMO_MODE_NOTICE =
  "Demo mode is active. The dashboard stays available with mock telemetry while live controls, diagnostics, and provisioning-dependent flows remain disabled.";
const DEMO_HUB_INFO: HubInfo = {
  name: "ProjectPlant Hub",
  version: "demo",
  debug: false,
  cors_origins: ["Demo preview only"],
  mqtt_enabled: false,
  mqtt_host: "demo",
  mqtt_port: 0,
  pot_telemetry_retention_hours: 168,
  pot_telemetry_max_rows: DEFAULT_POT_TELEMETRY_CAP,
  authMode: "local_compat",
  controlPlaneUrl: null,
  hubId: null,
  siteId: null,
  organizationId: null,
  currentReleaseId: null,
};
const DEMO_HEALTH_SUMMARY: HealthSummary = {
  status: "disabled",
  version: "demo",
  uptime: {
    started_at: null,
    seconds: null,
  },
  database: {
    status: "disabled",
    path: "Demo preview only",
    exists: false,
    size_bytes: null,
    latency_ms: null,
    error: null,
  },
};
const DEMO_MQTT_HEALTH: MqttHealth = {
  enabled: false,
  status: "disabled",
  connection: null,
  heartbeat: {
    status: "unknown",
    count: 0,
    latest_received_at: null,
    pots: [],
  },
};
const DEMO_WEATHER_HEALTH: WeatherCacheHealth = {
  status: "disabled",
  cache_dir: "Demo preview only",
  file_count: 0,
  bytes: 0,
  latest_modified: null,
  oldest_modified: null,
  age_seconds: null,
  state: "demo",
};

const MOBILE_BREAKPOINT_QUERY = "(max-width: 1023px)";

function getIsMobileLayout(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
}

function useIsMobileLayout(): boolean {
  const [isMobile, setIsMobile] = useState(getIsMobileLayout);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(event.matches);
    };

    setIsMobile(query.matches);
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", handleChange);
      return () => query.removeEventListener("change", handleChange);
    }

    query.addListener(handleChange);
    return () => query.removeListener(handleChange);
  }, []);

  return isMobile;
}

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

type ResolvedWeatherLocation = {
  lat: number;
  lon: number;
  accuracy: number | null;
  mode: "live" | "hub_last_synced" | "hub_fallback";
  source: string;
  observedAt: string | null;
  updatedAt: string | null;
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

function formatWeatherLocationMode(mode: ResolvedWeatherLocation["mode"]): string {
  if (mode === "hub_last_synced") {
    return "Last synced location";
  }
  if (mode === "hub_fallback") {
    return "Hub fallback location";
  }
  return "Live location";
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

function ErrorState({
  message,
  apiTarget,
  onRetry,
  onOpenSettings,
}: {
  message: string;
  apiTarget: string;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="rounded-2xl border border-rose-500/40 bg-[rgba(45,12,18,0.85)] p-6 text-rose-100 shadow-[0_20px_50px_rgba(30,10,16,0.4)]">
      <h2 className="text-lg font-semibold text-rose-100">Unable to reach the hub</h2>
      <p className="mt-2 text-sm text-rose-200/80">{message}</p>
      <p className="mt-2 text-xs text-rose-200/65">
        Current API target: <span className="font-mono text-rose-100">{apiTarget}</span>
      </p>
      <p className="mt-3 text-xs text-rose-200/65">
        Open Settings to change the hub address, or retry after the backend is listening.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/80 px-4 py-2 text-sm font-semibold text-rose-50 transition hover:border-rose-400/50 hover:bg-rose-400"
        >
          <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
          Try again
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex items-center gap-2 rounded-lg border border-rose-300/25 bg-transparent px-4 py-2 text-sm font-semibold text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-500/10"
        >
          <Cog6ToothIcon className="h-4 w-4" aria-hidden="true" />
          Open Settings
        </button>
      </div>
    </div>
  );
}

function DemoModeBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="rounded-2xl border border-sky-500/35 bg-[linear-gradient(135deg,rgba(7,28,22,0.92),rgba(6,18,32,0.86))] p-4 text-sm text-sky-100 shadow-[0_18px_40px_rgba(5,20,18,0.3)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-200/70">Demo Mode</p>
          <p className="mt-1 text-sm text-sky-50/90">{DEMO_MODE_NOTICE}</p>
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex items-center gap-2 rounded-lg border border-sky-400/35 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-100 transition hover:border-sky-300/60 hover:bg-sky-500/20"
        >
          <Cog6ToothIcon className="h-4 w-4" aria-hidden="true" />
          Open Settings
        </button>
      </div>
    </div>
  );
}

function LiveOnlyPanel({
  title,
  onOpenSettings,
}: {
  title: string;
  onOpenSettings: () => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-700/60 bg-[rgba(7,22,15,0.82)] p-6 text-sm text-emerald-100/85 shadow-inner shadow-emerald-950/40">
      <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-emerald-200/60">Live Only</p>
      <h2 className="mt-2 text-lg font-semibold text-emerald-50">{title} is unavailable in demo mode</h2>
      <p className="mt-2 text-sm text-emerald-200/70">{LIVE_ONLY_TAB_REASON}</p>
      <button
        type="button"
        onClick={onOpenSettings}
        className="mt-4 inline-flex items-center gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/60 hover:bg-emerald-500/20"
      >
        <Cog6ToothIcon className="h-4 w-4" aria-hidden="true" />
        Open Settings
      </button>
    </div>
  );
}

function recordString(value: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!value) {
    return null;
  }
  const next = value[key];
  return typeof next === "string" && next.trim() ? next.trim() : null;
}

function ManagedAccessBanner({
  settings,
  info,
}: {
  settings: UiSettings;
  info: HubInfo | null;
}) {
  const access = settings.effectiveAccess;
  if (settings.authMode !== "managed" || !access) {
    return null;
  }
  const scopeLabel = access.scopes.length ? access.scopes.join(" · ") : "No scoped assignments";
  return (
    <div className="rounded-2xl border border-sky-500/30 bg-[linear-gradient(135deg,rgba(8,33,23,0.92),rgba(10,31,44,0.9))] p-4 text-sm text-sky-100 shadow-[0_18px_40px_rgba(5,20,18,0.45)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-200/70">Managed Access</p>
          <p className="text-base font-semibold text-sky-50">
            {access.email} · {access.systemRole}
            {access.isPrimaryMaster ? " · primary master" : ""}
            {access.isBackupMaster ? " · backup master" : ""}
          </p>
          <p className="text-xs text-sky-100/70">{scopeLabel}</p>
          <p className="text-xs text-sky-100/60">
            Hub {info?.hubId || settings.effectiveAccess.hubs[0] || "unassigned"} · site {info?.siteId || access.sites[0] || "-"} · org {info?.organizationId || access.organizations[0] || "-"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-sky-100">
            MFA {access.mfaSatisfied ? "verified" : access.mfaRequired ? "required" : "optional"}
          </span>
          {settings.fleetConsoleUrl ? (
            <a
              href={settings.fleetConsoleUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-full border border-sky-400/30 bg-sky-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-sky-100 transition hover:border-sky-300/60 hover:bg-sky-500/20"
            >
              Open Fleet Console
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FleetQuickOpsTile({
  settings,
}: {
  settings: UiSettings;
}) {
  const access = settings.effectiveAccess;
  const visible = settings.authMode === "managed" && !!access;
  const managedQuickOpsSupported = !Capacitor.isNativePlatform();
  const canView = !!access && access.capabilities.includes("hub.view");
  const canUpdate = !!access && access.capabilities.includes("hub.update");
  const canRollback = !!access && access.capabilities.includes("hub.rollback");
  const canAudit = !!access && access.capabilities.includes("audit.view");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ hub: Record<string, unknown>; releases: Array<Record<string, unknown>> } | null>(null);
  const [auditEvents, setAuditEvents] = useState<Array<Record<string, unknown>>>([]);
  const [selectedReleaseId, setSelectedReleaseId] = useState("");
  const [actionStatus, setActionStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!visible || !canView || !managedQuickOpsSupported) {
      return;
    }
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const [nextSummary, nextAudit] = await Promise.all([
        fetchFleetHubSummary(),
        canAudit ? fetchFleetHubAudit(6) : Promise.resolve({ events: [] }),
      ]);
      setSummary(nextSummary);
      setAuditEvents(nextAudit.events);
      setSelectedReleaseId((current) => current || recordString(nextSummary.releases[0] as Record<string, unknown> | undefined, "releaseId") || "");
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : "Failed to load fleet quick ops.");
      setSummary(null);
      setAuditEvents([]);
    } finally {
      setSummaryLoading(false);
    }
  }, [canAudit, canView, managedQuickOpsSupported, visible]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!visible || !access) {
    return null;
  }

  if (!managedQuickOpsSupported) {
    return (
      <CollapsibleTile
        id="managed-fleet-quick-ops-mobile"
        title="Fleet Quick Ops"
        subtitle="Managed control-plane actions stay on the web console for mobile v1."
        className="text-sm text-emerald-100/90"
        bodyClassName="mt-4 space-y-3 text-emerald-100"
        titleClassName="text-base font-semibold text-emerald-50"
        subtitleClassName="text-xs text-emerald-200/70"
      >
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/90">
          Managed release, rollback, and audit operations are intentionally not supported in the Android wrapper yet.
        </p>
        {settings.fleetConsoleUrl ? (
          <a
            href={settings.fleetConsoleUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/60 hover:bg-emerald-500/20"
          >
            Open Fleet Console
          </a>
        ) : null}
      </CollapsibleTile>
    );
  }

  const hubRecord = summary?.hub ?? null;
  const releases = summary?.releases ?? [];
  const currentReleaseId = recordString(hubRecord, "currentReleaseId");
  const lastKnownGoodReleaseId = recordString(hubRecord, "lastKnownGoodReleaseId");
  const channel = recordString(hubRecord, "channel");
  const lastCheckInAt = recordString(hubRecord, "lastCheckInAt");

  return (
    <CollapsibleTile
      id="managed-fleet-quick-ops"
      title="Fleet Quick Ops"
      subtitle="Managed release controls and recent control-plane audit for this hub."
      className="text-sm text-emerald-100/90"
      bodyClassName="mt-4 space-y-4 text-emerald-100"
      titleClassName="text-base font-semibold text-emerald-50"
      subtitleClassName="text-xs text-emerald-200/70"
    >
      {summaryError ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">{summaryError}</div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-xl border border-emerald-700/40 bg-[rgba(8,28,20,0.72)] p-3">
          <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-200/60">Current Release</p>
          <p className="mt-2 text-lg font-semibold text-emerald-50">{currentReleaseId || "-"}</p>
        </div>
        <div className="rounded-xl border border-emerald-700/40 bg-[rgba(8,28,20,0.72)] p-3">
          <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-200/60">Last Known Good</p>
          <p className="mt-2 text-lg font-semibold text-emerald-50">{lastKnownGoodReleaseId || "-"}</p>
        </div>
        <div className="rounded-xl border border-emerald-700/40 bg-[rgba(8,28,20,0.72)] p-3">
          <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-200/60">Channel</p>
          <p className="mt-2 text-lg font-semibold text-emerald-50">{channel || "-"}</p>
        </div>
        <div className="rounded-xl border border-emerald-700/40 bg-[rgba(8,28,20,0.72)] p-3">
          <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-200/60">Last Check-In</p>
          <p className="mt-2 text-sm font-semibold text-emerald-50">{formatIsoTimestamp(lastCheckInAt)}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selectedReleaseId}
          onChange={(event) => setSelectedReleaseId(event.target.value)}
          className="min-w-[14rem] rounded-lg border border-emerald-600/30 bg-[rgba(7,28,20,0.82)] px-3 py-2 text-sm text-emerald-50 focus:outline-none focus:ring-2 focus:ring-emerald-400/50"
        >
          <option value="">Select release</option>
          {releases.map((release, index) => {
            const releaseId = recordString(release, "releaseId") || `release-${index}`;
            const releaseChannel = recordString(release, "channel");
            return (
              <option key={releaseId} value={releaseId}>
                {releaseId}{releaseChannel ? ` · ${releaseChannel}` : ""}
              </option>
            );
          })}
        </select>
        <button
          type="button"
          onClick={() =>
            void (async () => {
              if (!selectedReleaseId) {
                setActionStatus("Select a release first.");
                return;
              }
              try {
                setActionStatus("Queueing update...");
                await queueFleetHubUpdate(selectedReleaseId);
                setActionStatus(`Queued update to ${selectedReleaseId}.`);
                await refresh();
              } catch (err) {
                setActionStatus(err instanceof Error ? err.message : "Failed to queue update.");
              }
            })()
          }
          disabled={!canUpdate || !selectedReleaseId || summaryLoading}
          className="inline-flex items-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Queue Update
        </button>
        <button
          type="button"
          onClick={() =>
            void (async () => {
              try {
                setActionStatus("Queueing rollback...");
                await queueFleetHubRollback();
                setActionStatus("Queued rollback to the last known good release.");
                await refresh();
              } catch (err) {
                setActionStatus(err instanceof Error ? err.message : "Failed to queue rollback.");
              }
            })()
          }
          disabled={!canRollback || summaryLoading}
          className="inline-flex items-center rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-100 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Queue Rollback
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={summaryLoading}
          className="inline-flex items-center rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-sm font-semibold text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {summaryLoading ? "Refreshing..." : "Refresh Fleet Data"}
        </button>
        {settings.fleetConsoleUrl ? (
          <a
            href={settings.fleetConsoleUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center rounded-lg border border-slate-500/30 bg-slate-500/10 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-500/20"
          >
            Fleet Console
          </a>
        ) : null}
      </div>

      {actionStatus ? <p className="text-xs text-emerald-200/75">{actionStatus}</p> : null}

      {canAudit ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200/60">Recent Audit</p>
          {auditEvents.length ? (
            auditEvents.map((event, index) => (
              <div
                key={recordString(event, "eventId") || `audit-${index}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-700/30 bg-[rgba(7,24,18,0.72)] px-3 py-2 text-xs"
              >
                <div>
                  <p className="font-semibold text-emerald-50">{recordString(event, "eventType") || "event"}</p>
                  <p className="text-emerald-200/60">{formatIsoTimestamp(recordString(event, "createdAt"))}</p>
                </div>
                <span className="uppercase tracking-wide text-emerald-200/70">{recordString(event, "outcome") || "-"}</span>
              </div>
            ))
          ) : (
            <p className="text-xs text-emerald-200/70">No audit events available for this hub.</p>
          )}
        </div>
      ) : null}
    </CollapsibleTile>
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
        subtitle="This browser does not support geolocation. If the hub already has a synced weather location, local conditions can still use it."
        className="text-sm text-emerald-100/85"
        bodyClassName="mt-2 space-y-2"
      >
        <p>Open the dashboard on a device that can share location once, or use a browser that supports geolocation.</p>
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
        Coordinates are sent to the hub to resolve the closest station and sync the active HRRR weather location. You can
        revoke access at any time from your browser settings.
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

function loadPersistedManualDuration(): string {
  if (typeof window === "undefined") {
    return "60";
  }
  try {
    const stored = window.localStorage.getItem(CONTROL_DURATION_STORAGE_KEY);
    if (stored === null) {
      return "60";
    }
    return stored;
  } catch {
    return "60";
  }
}

function persistManualDuration(value: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CONTROL_DURATION_STORAGE_KEY, value);
  } catch {
    // ignore storage failures
  }
}

function resolveEventStreamAccess(settings: UiSettings, liveMode: boolean): { enabled: boolean; authKey: string } {
  const authMode = settings.authMode?.trim() || "local_compat";
  const authToken = getAuthTokenSync();
  const activeUserId = getActiveUserIdSync();
  const hasBearerToken = Boolean(authToken);
  const hasLocalIdentity = Boolean(activeUserId);

  if (!liveMode) {
    return {
      enabled: false,
      authKey: JSON.stringify({ liveMode: false, authMode }),
    };
  }

  return {
    enabled: authMode === "managed" ? hasBearerToken : hasBearerToken || hasLocalIdentity,
    authKey: JSON.stringify({
      liveMode: true,
      authMode,
      authToken: hasBearerToken ? authToken : "",
      activeUserId: authMode === "managed" ? "" : activeUserId,
    }),
  };
}

export default function App() {
  const initialSettings = getSettings();
  const [sessionSettings, setSessionSettings] = useState<UiSettings>(initialSettings);
  const apiTargetLabel = useMemo(() => getApiTargetLabelSync(), [sessionSettings.serverBaseUrl]);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(initialSettings.mode);
  const liveMode = runtimeMode === "live";
  const eventStreamAccess = useMemo(
    () => resolveEventStreamAccess(sessionSettings, liveMode),
    [
      liveMode,
      sessionSettings.activeUserId,
      sessionSettings.authMode,
      sessionSettings.authToken,
      sessionSettings.authTokenExpiresAt,
    ]
  );
  const { data: hubInfo, loading: hubLoading, error: hubError, refresh: refreshHubInfo } = useHubInfo(liveMode);
  const {
    summary: liveHealthSummary,
    mqtt: liveHealthMqtt,
    weather: liveHealthWeather,
    storage: healthStorage,
    events: healthEvents,
    eventsCount: healthEventsCount,
    loading: healthLoading,
    error: healthError,
    refresh: refreshHealth,
  } = useHealthDiagnostics(50, liveMode);
  const effectiveHubInfo = liveMode ? hubInfo : DEMO_HUB_INFO;
  const effectiveHealthSummary = liveMode ? liveHealthSummary : DEMO_HEALTH_SUMMARY;
  const effectiveHealthMqtt = liveMode ? liveHealthMqtt : DEMO_MQTT_HEALTH;
  const effectiveHealthWeather = liveMode ? liveHealthWeather : DEMO_WEATHER_HEALTH;
  const potTelemetryMaxRows = useMemo(() => {
    const raw = effectiveHubInfo?.pot_telemetry_max_rows;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw;
    }
    return DEFAULT_POT_TELEMETRY_CAP;
  }, [effectiveHubInfo]);
  const initialTelemetrySource = initialSettings.mode === "live" ? DEFAULT_TELEMETRY_POTS[0] : "mock";
  useEventSource(eventStreamAccess.enabled, eventStreamAccess.authKey);
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
  const {
    location: hubWeatherLocation,
    loading: hubWeatherLocationLoading,
    syncLocation: syncHubWeatherLocation,
  } = useHubWeatherLocation(liveMode);
  const locationSyncKeyRef = useRef<string | null>(null);
  const resolvedLocalLocation = useMemo<ResolvedWeatherLocation | null>(() => {
    if (!liveMode) {
      return null;
    }
    if (geolocation.coords) {
      return {
        lat: geolocation.coords.lat,
        lon: geolocation.coords.lon,
        accuracy: geolocation.coords.accuracy,
        mode: "live",
        source: "browser_geolocation",
        observedAt: null,
        updatedAt: null,
      };
    }
    if (!hubWeatherLocation) {
      return null;
    }
    return {
      lat: hubWeatherLocation.lat,
      lon: hubWeatherLocation.lon,
      accuracy: hubWeatherLocation.accuracyM,
      mode: hubWeatherLocation.source === "config_fallback" ? "hub_fallback" : "hub_last_synced",
      source: hubWeatherLocation.source,
      observedAt: hubWeatherLocation.observedAt,
      updatedAt: hubWeatherLocation.updatedAt,
    };
  }, [geolocation.coords, hubWeatherLocation, liveMode]);
  const localWeatherCoordinates = useMemo(
    () =>
      resolvedLocalLocation
        ? {
            lat: resolvedLocalLocation.lat,
            lon: resolvedLocalLocation.lon,
          }
        : null,
    [resolvedLocalLocation]
  );
  const [localRange, setLocalRange] = useState<LocalRange>(6);
  const [activeChartTab, setActiveChartTab] = useState<HubTab>("plant");
  const isMobileLayout = useIsMobileLayout();
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
    blendMode: localBlendMode,
    hrrrError: localHrrrError,
    refresh: refreshLocal,
  } = useLocalWeather(localWeatherCoordinates, localRange, { maxSamples: 200 });
  const latestSourceDisplay = useMemo(() => {
    if (localBlendMode === "station_hrrr_solar") {
      return "NOAA Station + HRRR Solar";
    }
    if (localBlendMode === "hrrr") {
      return "NOAA HRRR Solar";
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
  }, [localBlendMode, localSources, localLatest?.source]);
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
    const syncSettings = () => setSessionSettings(getSettings());
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === "projectplant:ui:settings") {
        syncSettings();
      }
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener("projectplant:settings-changed", syncSettings);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("projectplant:settings-changed", syncSettings);
    };
  }, []);

  useEffect(() => {
    if (!liveMode || !hubInfo) {
      return;
    }
    const current = getSettings();
    const nextAuthMode = hubInfo.authMode?.trim() || current.authMode || "local_compat";
    const nextControlPlaneUrl = hubInfo.controlPlaneUrl?.trim() ?? current.controlPlaneUrl;
    const nextFleetConsoleUrl = nextControlPlaneUrl ? nextControlPlaneUrl.replace(/\/$/, "") : current.fleetConsoleUrl;
    if (
      current.authMode === nextAuthMode &&
      current.controlPlaneUrl === nextControlPlaneUrl &&
      current.fleetConsoleUrl === nextFleetConsoleUrl
    ) {
      return;
    }
    setSettings({
      ...current,
      authMode: nextAuthMode,
      controlPlaneUrl: nextControlPlaneUrl,
      fleetConsoleUrl: nextFleetConsoleUrl,
    });
  }, [hubInfo, liveMode]);

  useEffect(() => {
    if (!liveMode) {
      setTelemetrySource("mock");
      if (activeChartTab !== "plant") {
        setActiveChartTab("plant");
      }
    }
  }, [activeChartTab, liveMode]);

  useEffect(() => {
    if (!liveMode || geolocation.status !== "granted" || !geolocation.coords) {
      locationSyncKeyRef.current = null;
      return undefined;
    }
    const syncKey = [
      geolocation.coords.lat.toFixed(6),
      geolocation.coords.lon.toFixed(6),
      geolocation.coords.accuracy != null ? geolocation.coords.accuracy.toFixed(1) : "na",
    ].join(":");
    if (locationSyncKeyRef.current === syncKey) {
      return undefined;
    }
    locationSyncKeyRef.current = syncKey;
    void syncHubWeatherLocation({
      lat: geolocation.coords.lat,
      lon: geolocation.coords.lon,
      accuracyM: geolocation.coords.accuracy,
      source: "browser_geolocation",
      observedAt: new Date().toISOString(),
    }).catch(() => {
      if (locationSyncKeyRef.current === syncKey) {
        locationSyncKeyRef.current = null;
      }
    });
    return undefined;
  }, [geolocation.coords, geolocation.status, liveMode, syncHubWeatherLocation]);

  useEffect(() => {
    if (!liveMode || !resolvedLocalLocation) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      refreshLocal();
    }, 60 * 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, [liveMode, refreshLocal, resolvedLocalLocation]);

  const availablePotIds = useEventStore((state) => Object.keys(state.potTelemetry));
  const pumpStatusPotIds = useEventStore((state) => Object.keys(state.pumpStatus));
  const potIdentities = useEventStore(selectPotIdentities);
  const [dismissedPotIds, setDismissedPotIds] = useState<string[]>([]);
  const [namingTarget, setNamingTarget] = useState<DeviceIdentity | null>(null);
  const healthRefreshRef = useRef(0);
  const requestHealthRefresh = useCallback(
    (force = false) => {
      if (!liveMode) {
        return;
      }
      const now = Date.now();
      if (!force && now - healthRefreshRef.current < HEALTH_REFRESH_THROTTLE_MS) {
        return;
      }
      healthRefreshRef.current = now;
      refreshHealth();
    },
    [liveMode, refreshHealth]
  );
  const heartbeatPotIds = useMemo(() => {
    const pots = effectiveHealthMqtt?.heartbeat?.pots ?? [];
    const ids = pots
      .map((entry) => (entry.pot_id ?? "").trim().toLowerCase())
      .filter((id) => id.length > 0);
    return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
  }, [effectiveHealthMqtt]);
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
    const entries = effectiveHealthMqtt?.heartbeat?.pots ?? [];
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
  }, [effectiveHealthMqtt]);

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

  const watering = useWateringRecommendation(mockTelemetry, DEFAULT_WATERING_OPTIONS, liveMode);

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
      return localBlendMode === "hrrr" ? `Forecast valid ${label}` : label;
    }
    if (localLoading) {
      return localBlendMode === "hrrr" ? "Loading latest forecast..." : "Loading latest weather...";
    }
    if (localError) {
      return `Latest weather unavailable: ${localError}`;
    }
    return localBlendMode === "hrrr" ? "Forecast timestamp unavailable" : "Weather timestamp unavailable";
  }, [localLatest?.timestamp, localLoading, localError, localBlendMode]);

  const title = useMemo(() => effectiveHubInfo?.name || "ProjectPlant Hub", [effectiveHubInfo]);
  const pageSubtitle = liveMode
    ? "Monitor broker connectivity and hub health as we iterate on the UI."
    : "Preview the dashboard with demo telemetry while live hub features stay disabled.";

  const handleRefresh = useCallback(() => {
    if (liveMode) {
      refreshHubInfo();
      requestHealthRefresh(true);
    }
    refreshTelemetry();
    if (liveMode && resolvedLocalLocation) {
      refreshLocal();
    }
    if (telemetrySource !== "mock") {
      setPotTelemetryTicker((prev) => prev + 1);
    }
  }, [liveMode, refreshHubInfo, refreshTelemetry, requestHealthRefresh, refreshLocal, resolvedLocalLocation, telemetrySource]);

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

  const mobilePrimaryTab = useMemo<"home" | "controls" | "plants" | "diagnostics">(() => {
    if (activeChartTab === "control") {
      return "controls";
    }
    if (activeChartTab === "myplants") {
      return "plants";
    }
    if (activeChartTab === "diagnostics") {
      return "diagnostics";
    }
    return "home";
  }, [activeChartTab]);

  const mobileHomeTab = activeChartTab === "local" ? "local" : "plant";

  const handleMobilePrimaryTab = useCallback((tab: "home" | "controls" | "plants" | "diagnostics") => {
    if (tab === "home") {
      setActiveChartTab("plant");
      return;
    }
    if (tab === "controls") {
      setActiveChartTab("control");
      return;
    }
    if (tab === "plants") {
      setActiveChartTab("myplants");
      return;
    }
    setActiveChartTab("diagnostics");
  }, []);

  const openSetupWizard = useCallback(() => {
    if (typeof window !== "undefined") {
      window.location.assign("/setup");
    }
  }, []);

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
    if (!liveMode && activeChartTab !== "plant") {
      const label =
        activeChartTab === "control"
          ? "Plant Control"
          : activeChartTab === "local"
            ? "Local Area Conditions"
            : activeChartTab === "myplants"
              ? "My Plants"
              : "Diagnostics";
      return <LiveOnlyPanel title={label} onOpenSettings={() => setSettingsOpen(true)} />;
    }

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
        return (
          <ErrorState
            message={chartError}
            apiTarget={apiTargetLabel}
            onRetry={handleRefresh}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        );
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
        <div className="space-y-6">
          <FleetQuickOpsTile settings={sessionSettings} />
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
        </div>
      );
    }

    if (activeChartTab === "local") {
      if (!resolvedLocalLocation) {
        if (hubWeatherLocationLoading) {
          return <LoadingState message="Loading the hub weather location..." />;
        }
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
        return (
          <ErrorState
            message={localError}
            apiTarget={apiTargetLabel}
            onRetry={refreshLocal}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        );
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
      const locationModeLabel = formatWeatherLocationMode(resolvedLocalLocation.mode);
      const subtitleParts = [
        resolvedLocalLocation.mode !== "live" ? locationModeLabel : null,
        baseStationLabel ? `Nearest station: ${baseStationLabel}` : null,
        stationDistance,
        coverageLabel,
      ].filter(Boolean) as string[];
      const subtitle = subtitleParts.length
        ? subtitleParts.join(" · ")
        : resolvedLocalLocation.mode === "live"
          ? "Live observations from public data."
          : `${locationModeLabel} · Live observations from public data.`;

      return (
        <div className="space-y-4">
          <TelemetryChart data={localWeather} title="Local Area Conditions" subtitle={subtitle} />
          <LocalConditionsMap
            lat={resolvedLocalLocation.lat}
            lon={resolvedLocalLocation.lon}
            accuracy={resolvedLocalLocation.accuracy}
            station={localStation}
            sources={localSources}
            locationLabel={locationModeLabel}
          />
        </div>
      );
    }

    if (activeChartTab === "diagnostics") {
      return (
        <div className="space-y-6">
          <FleetQuickOpsTile settings={sessionSettings} />
          <DiagnosticsPage
            summary={effectiveHealthSummary}
            mqtt={effectiveHealthMqtt}
            weather={effectiveHealthWeather}
            storage={healthStorage}
            events={healthEvents}
            eventsCount={healthEventsCount}
            loading={healthLoading}
            error={healthError}
            onRefresh={refreshHealth}
          />
        </div>
      );
    }

    return null;
  }, [
    activeChartTab,
    controlStates,
    geolocation.error,
    geolocation.requestPermission,
    geolocation.status,
    hubWeatherLocationLoading,
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
    sessionSettings,
    coverageHours,
    localStation,
    runtimeMode,
    watering,
    effectiveHealthSummary,
    effectiveHealthMqtt,
    effectiveHealthWeather,
    healthStorage,
    healthEvents,
    healthEventsCount,
    healthLoading,
    healthError,
    refreshHealth,
    requestHealthRefresh,
    resolvedLocalLocation,
    controlPotIds,
    potIdentities,
    handleManualRename,
    liveMode,
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
      subtitle={pageSubtitle}
      actions={
        <div className="flex items-center gap-2">
          <ConnectionBadges
            rest={{
              loading: liveMode ? hubLoading : false,
              error: liveMode ? hubError : null,
              data: liveMode ? hubInfo : null,
            }}
            events={eventConnectionState}
          />
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
      <div className={`space-y-12 ${isMobileLayout ? "pb-24" : ""}`}>
        <div className="-mx-6 lg:-mx-12 xl:-mx-20">
          {liveMode && hubLoading ? (
            <div className="flex min-h-[24rem] w-full items-center justify-center bg-[rgba(6,27,18,0.88)] px-6 py-16 shadow-[0_30px_80px_rgba(6,24,16,0.65)]">
              <div className="flex items-center gap-3 text-emerald-100/80">
                <span className="inline-flex h-4 w-4 animate-ping rounded-full bg-emerald-400/80" />
                <span className="text-base font-semibold tracking-[0.35em] text-emerald-200/80">
                  WAKING THE HUB
                </span>
              </div>
            </div>
          ) : null}
          {liveMode && !hubLoading && hubError ? (
            <div className="px-6 lg:px-12 xl:px-20">
              <ErrorState
                message={hubError}
                apiTarget={apiTargetLabel}
                onRetry={handleRefresh}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            </div>
          ) : null}
          {(!liveMode || !hubLoading) && !hubError ? <HubHeroTile info={effectiveHubInfo} /> : null}
        </div>

        {!liveMode ? (
          <div className="mx-auto w-full max-w-6xl px-6 lg:px-12 xl:px-20">
            <DemoModeBanner onOpenSettings={() => setSettingsOpen(true)} />
          </div>
        ) : null}

        {(!liveMode || !hubLoading) ? (
          <div className="px-6 lg:px-12 xl:px-20 mt-6">
            <StatusBar
              summary={effectiveHealthSummary}
              mqtt={effectiveHealthMqtt}
              weather={effectiveHealthWeather}
              loading={liveMode && (hubLoading || healthLoading)}
              error={liveMode ? (healthError ?? hubError) : null}
              onHandleCache={liveMode ? () => setCacheManagerOpen(true) : undefined}
            />
          </div>
        ) : null}

        {liveMode && !hubLoading ? (
          <div className="mx-auto w-full max-w-6xl px-6 lg:px-12 xl:px-20">
            <ManagedAccessBanner settings={sessionSettings} info={hubInfo} />
          </div>
        ) : null}

        {(!liveMode || !hubLoading) && !hubError ? (
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            {isMobileLayout ? (
              <div className="space-y-3 rounded-2xl border border-emerald-700/40 bg-[rgba(6,27,18,0.75)] p-3 text-sm font-medium text-emerald-200/80 shadow-inner shadow-emerald-950/60">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.24em] text-emerald-200/55">Mobile Shell</p>
                    <p className="mt-1 text-sm text-emerald-50">
                      {mobilePrimaryTab === "home"
                        ? mobileHomeTab === "local"
                          ? "Local weather"
                          : "Home"
                        : mobilePrimaryTab === "controls"
                          ? "Controls"
                          : mobilePrimaryTab === "plants"
                            ? "Plants"
                            : "Diagnostics"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={openSetupWizard}
                    className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/60 hover:bg-emerald-500/20"
                  >
                    <WifiIcon className="h-4 w-4" aria-hidden="true" />
                    Setup
                  </button>
                </div>
                {mobilePrimaryTab === "home" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <TabButton
                      label="Plant Overview"
                      isActive={mobileHomeTab === "plant"}
                      onClick={() => setActiveChartTab("plant")}
                    />
                    <TabButton
                      label="Local Weather"
                      isActive={mobileHomeTab === "local"}
                      onClick={() => setActiveChartTab("local")}
                      disabled={!liveMode}
                      title={!liveMode ? LIVE_ONLY_TAB_REASON : undefined}
                    />
                  </div>
                ) : null}
                {activeChartTab === "plant" ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <TelemetrySourceSelector value={telemetrySource} options={telemetryOptions} onChange={setTelemetrySource} />
                    <TelemetryRangeSelector
                      value={telemetryRangeKey}
                      options={TELEMETRY_RANGE_PRESETS}
                      onChange={setTelemetryRangeKey}
                      disabled={telemetrySource === "mock"}
                    />
                  </div>
                ) : null}
                {activeChartTab === "local" && resolvedLocalLocation ? (
                  <LocalRangeSelector
                    value={localRange}
                    options={availableRangeOptions as LocalRange[]}
                    onChange={setLocalRange}
                  />
                ) : null}
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-700/40 bg-[rgba(6,27,18,0.75)] p-2 text-sm font-medium text-emerald-200/80 shadow-inner shadow-emerald-950/60">
                <div className="inline-flex rounded-xl border border-emerald-500/30 bg-[rgba(9,39,25,0.65)] p-1">
                  <TabButton label="Plant Conditions" isActive={activeChartTab === "plant"} onClick={() => setActiveChartTab("plant")} />
                  <TabButton
                    label="Plant Control"
                    isActive={activeChartTab === "control"}
                    onClick={() => setActiveChartTab("control")}
                    disabled={!liveMode}
                    title={!liveMode ? LIVE_ONLY_TAB_REASON : undefined}
                  />
                  <TabButton
                    label="Local Area Conditions"
                    isActive={activeChartTab === "local"}
                    onClick={() => setActiveChartTab("local")}
                    disabled={!liveMode}
                    title={!liveMode ? LIVE_ONLY_TAB_REASON : undefined}
                  />
                  <TabButton
                    label="My Plants"
                    isActive={activeChartTab === "myplants"}
                    onClick={() => setActiveChartTab("myplants")}
                    disabled={!liveMode}
                    title={!liveMode ? LIVE_ONLY_TAB_REASON : undefined}
                  />
                  <TabButton
                    label="Diagnostics"
                    isActive={activeChartTab === "diagnostics"}
                    onClick={() => setActiveChartTab("diagnostics")}
                    disabled={!liveMode}
                    title={!liveMode ? LIVE_ONLY_TAB_REASON : undefined}
                  />
                </div>
                {activeChartTab === "plant" ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <TelemetrySourceSelector value={telemetrySource} options={telemetryOptions} onChange={setTelemetrySource} />
                    <TelemetryRangeSelector
                      value={telemetryRangeKey}
                      options={TELEMETRY_RANGE_PRESETS}
                      onChange={setTelemetryRangeKey}
                      disabled={telemetrySource === "mock"}
                    />
                  </div>
                ) : null}
                {activeChartTab === "local" && resolvedLocalLocation ? (
                  <LocalRangeSelector
                    value={localRange}
                    options={availableRangeOptions as LocalRange[]}
                    onChange={setLocalRange}
                  />
                ) : null}
              </div>
            )}
            {activeChartTab === "myplants" ? <MyPlantsTab /> : chartContent}

            {activeChartTab === "plant" ? (
              <>
                <TelemetrySummary latest={displayLatest} />
                <WaterModelSection plantId={telemetrySource === "mock" ? undefined : telemetrySource} />
                <div className="grid gap-6 lg:grid-cols-3">
                  <div className="space-y-6 lg:col-span-2">
                    <MqttDiagnostics info={effectiveHubInfo} />
                    <TelemetryTable
                      data={displayTelemetry}
                      rangeLabel={telemetrySource === "mock" ? undefined : potTelemetryRangeLabel}
                    />
                  </div>
                  <CorsOriginsCard origins={effectiveHubInfo.cors_origins} />
                </div>
              </>
            ) : activeChartTab === "local" && resolvedLocalLocation ? (
              <div className="grid gap-6">
                <CollapsibleTile
                  id="local-conditions-latest-observation"
                  title="Latest Local Weather"
                  subtitle={localLatestSubtitle}
                  className="text-sm text-emerald-100/90"
                  bodyClassName="mt-4 space-y-2 text-emerald-100"
                  titleClassName="text-base font-semibold text-emerald-50"
                  subtitleClassName="text-xs text-emerald-200/70"
                >
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 font-semibold uppercase tracking-wide text-sky-100/90">
                        {latestSourceDisplay ?? "Local Weather"}
                      </span>
                      {resolvedLocalLocation.mode !== "live" ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 font-semibold uppercase tracking-wide text-emerald-100/90">
                          {formatWeatherLocationMode(resolvedLocalLocation.mode)}
                        </span>
                      ) : null}
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
                    <LoadingState message={localBlendMode === "hrrr" ? "Loading latest forecast..." : "Loading latest weather..."} />
                  ) : localError && !localLatest ? (
                    <ErrorState
                      message={localError}
                      apiTarget={apiTargetLabel}
                      onRetry={refreshLocal}
                      onOpenSettings={() => setSettingsOpen(true)}
                    />
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
                        {resolvedLocalLocation.mode !== "live" ? (
                          <li>Location Mode: {formatWeatherLocationMode(resolvedLocalLocation.mode)}</li>
                        ) : null}
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
        {isMobileLayout ? (
          <MobileBottomNav
            activeTab={mobilePrimaryTab}
            onSelect={handleMobilePrimaryTab}
            onSetup={openSetupWizard}
          />
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
    isOn: icZone1IsOn,
    pending: icZone1Pending,
    requestId: icZone1RequestId,
    lastConfirmedAt: icZone1LastConfirmedAt,
    feedback: icZone1Feedback,
    clearFeedback: clearIcZone1Feedback,
    toggle: toggleIcZone1,
    syncTelemetry: syncIcZone1Telemetry,
  } = useIcZone1Control(undefined, trimmedPotId);
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
  const [manualDurationSec, setManualDurationSec] = useState<string>(() => loadPersistedManualDuration());
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
    clearIcZone1Feedback();
    clearPumpFeedback();
    clearFanFeedback();
    clearMisterFeedback();
    clearLightFeedback();
  }, [
    trimmedPotId,
    sensorRead.reset,
    clearIcZone1Feedback,
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

  useEffect(() => {
    persistManualDuration(manualDurationSec);
  }, [manualDurationSec]);

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
    if (!icZone1Feedback) {
      return;
    }
    const timer = setTimeout(() => clearIcZone1Feedback(), 5000);
    return () => clearTimeout(timer);
  }, [icZone1Feedback, clearIcZone1Feedback]);
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
    syncIcZone1Telemetry(payload);
    syncPumpTelemetry(payload);
    syncFanTelemetry(payload);
    syncMisterTelemetry(payload);
    syncLightTelemetry(payload);
  }, [
    sensorSnapshot,
    sensorRead.requestId,
    syncIcZone1Telemetry,
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
    if (typeof status.icZone1On === "boolean") {
      syncIcZone1Telemetry({
        icZone1On: status.icZone1On,
        timestamp: status.timestamp ?? null,
        timestampMs: status.timestampMs ?? null,
        requestId: status.requestId ?? null,
      });
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
  }, [
    pumpStatusMap,
    syncIcZone1Telemetry,
    syncPumpTelemetry,
    syncFanTelemetry,
    syncMisterTelemetry,
    syncLightTelemetry,
    trimmedPotId,
  ]);

  const isSubmitDisabled = sensorRead.loading || !trimmedPotId;
  const snapshotTimestamp = sensorSnapshot
    ? snapshotTimestampLabel(sensorSnapshot.timestamp, sensorSnapshot.timestampMs ?? null)
    : null;

  const moistureValue = formatMaybeNumber(sensorSnapshot?.moisture ?? NaN, 1);
  const temperatureValue = formatMaybeNumber(sensorSnapshot?.temperature ?? NaN, 1);
  const humidityValue = formatMaybeNumber(sensorSnapshot?.humidity ?? NaN, 1);
  const flowRateValue = formatMaybeNumber(sensorSnapshot?.flowRateLpm ?? NaN, 2);
  const pumpDisplay =
    typeof sensorSnapshot?.valveOpen === "boolean"
      ? sensorSnapshot.valveOpen
        ? "On"
        : "Off"
      : "Unknown";
  const icZone1Display =
    typeof sensorSnapshot?.icZone1On === "boolean"
      ? sensorSnapshot.icZone1On
        ? "On"
        : "Off"
      : typeof sensorSnapshot?.valveOpen === "boolean"
        ? sensorSnapshot.valveOpen
          ? "On"
          : "Off"
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
  const manualOverrideDurationMs = useMemo(() => {
    const trimmed = manualDurationSec.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return undefined;
    }
    return Math.round(parsed * 1000);
  }, [manualDurationSec]);
  const manualDurationInvalid = manualDurationSec.trim().length > 0 && manualOverrideDurationMs === undefined;

  const icZone1StatusLabel = icZone1Pending
    ? "Pending"
    : icZone1IsOn === null
      ? "Unknown"
      : icZone1IsOn
        ? "On"
        : "Off";
  const icZone1Helper = (() => {
    if (!trimmedPotId) {
      return "Select a control pot above to enable IC Zone 1 control.";
    }
    if (icZone1Pending) {
      return "Awaiting confirmation from the hub...";
    }
    if (icZone1LastConfirmedAt) {
      return icZone1RequestId
        ? `Last confirmed ${icZone1LastConfirmedAt} - Request ${icZone1RequestId}`
        : `Last confirmed ${icZone1LastConfirmedAt}`;
    }
    return "Tap to toggle IC Zone 1.";
  })();
  const icZone1ButtonDisabled = !trimmedPotId || icZone1Pending;
  const handleIcZone1Toggle = useCallback(() => {
    void toggleIcZone1({ potId: trimmedPotId, durationMs: manualOverrideDurationMs });
  }, [manualOverrideDurationMs, toggleIcZone1, trimmedPotId]);

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
        ? `Last confirmed ${pumpLastConfirmedAt} - Request ${pumpRequestId}`
        : `Last confirmed ${pumpLastConfirmedAt}`;
    }
    return "Tap to toggle the pump.";
  })();
  const pumpButtonDisabled = !trimmedPotId || pumpPending;
  const handlePumpToggle = useCallback(() => {
    void togglePump({ potId: trimmedPotId, durationMs: manualOverrideDurationMs });
  }, [manualOverrideDurationMs, togglePump, trimmedPotId]);

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
    void toggleFan({ potId: trimmedPotId, durationMs: manualOverrideDurationMs });
  }, [manualOverrideDurationMs, toggleFan, trimmedPotId]);

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
    void toggleMister({ potId: trimmedPotId, durationMs: manualOverrideDurationMs });
  }, [manualOverrideDurationMs, toggleMister, trimmedPotId]);

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
    void toggleLight({ potId: trimmedPotId, durationMs: manualOverrideDurationMs });
  }, [manualOverrideDurationMs, toggleLight, trimmedPotId]);

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
        {icZone1Feedback ? (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-xs ${
                icZone1Feedback.type === "success"
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
                : icZone1Feedback.type === "error"
                  ? "border-rose-500/50 bg-rose-500/10 text-rose-200"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200/80"
              }`}
            >
              {icZone1Feedback.message}
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
        <div className="flex flex-col gap-2 rounded-xl border border-emerald-800/40 bg-[rgba(6,24,16,0.72)] px-4 py-3 text-xs text-emerald-100/80">
          <label className="flex flex-col gap-1 text-emerald-200/70">
            Manual override duration (seconds)
            <input
              type="number"
              min={1}
              step={1}
              value={manualDurationSec}
              onChange={(event) => setManualDurationSec(event.target.value)}
              placeholder="e.g. 60"
              className="mt-1 max-w-[12rem] rounded-lg border border-emerald-700/50 bg-[rgba(6,30,20,0.88)] px-3 py-2 text-sm text-emerald-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
            />
          </label>
          <p className={`text-[11px] ${manualDurationInvalid ? "text-rose-200" : "text-emerald-200/60"}`}>
            {manualDurationInvalid
              ? "Enter a positive number of seconds or leave blank for the device default."
              : "Leave blank to use the device default."}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {CONTROL_DEVICES.map((device) => {
              if (device.id === "ic_zone1") {
                return (
                  <ControlToggleButton
                    key={device.id}
                    label={device.label}
                    isOn={icZone1IsOn ?? false}
                    status={icZone1StatusLabel}
                    helper={icZone1Helper}
                    disabled={icZone1ButtonDisabled}
                    onClick={handleIcZone1Toggle}
                  />
                );
              }
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
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">IC Zone 1</dt>
                      <dd className="text-sm text-emerald-100">{icZone1Display}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-emerald-200/60">Pump</dt>
                      <dd className="text-sm text-emerald-100">{pumpDisplay}</dd>
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
  disabled = false,
  title,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg px-4 py-2 transition ${
        disabled
          ? "cursor-not-allowed border border-transparent text-emerald-200/30"
          : isActive
          ? "border border-emerald-400/50 bg-[rgba(12,52,32,0.85)] text-emerald-50 shadow-lg shadow-emerald-950/50"
          : "border border-transparent text-emerald-200/60 hover:border-emerald-500/40 hover:text-emerald-100"
      }`}
    >
      {label}
    </button>
  );
}

function MobileBottomNav({
  activeTab,
  onSelect,
  onSetup,
}: {
  activeTab: "home" | "controls" | "plants" | "diagnostics";
  onSelect: (tab: "home" | "controls" | "plants" | "diagnostics") => void;
  onSetup: () => void;
}) {
  const items = [
    { id: "home" as const, label: "Home", Icon: HomeIcon, action: () => onSelect("home") },
    { id: "controls" as const, label: "Controls", Icon: WrenchScrewdriverIcon, action: () => onSelect("controls") },
    { id: "plants" as const, label: "Plants", Icon: Squares2X2Icon, action: () => onSelect("plants") },
    { id: "diagnostics" as const, label: "Diagnostics", Icon: Cog6ToothIcon, action: () => onSelect("diagnostics") },
    { id: "setup" as const, label: "Setup", Icon: WifiIcon, action: onSetup },
  ];

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-emerald-700/40 bg-[rgba(4,18,12,0.96)] px-2 pb-[calc(env(safe-area-inset-bottom,0px)+0.5rem)] pt-2 shadow-[0_-18px_36px_rgba(4,18,12,0.55)] backdrop-blur">
      <div className="mx-auto grid max-w-6xl grid-cols-5 gap-1">
        {items.map(({ id, label, Icon, action }) => {
          const isActive = id !== "setup" && activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={action}
              className={`flex min-h-[4rem] flex-col items-center justify-center rounded-2xl px-2 py-2 text-[11px] font-semibold transition ${
                isActive
                  ? "bg-emerald-500/20 text-emerald-50"
                  : "text-emerald-200/70 hover:bg-emerald-500/10 hover:text-emerald-100"
              }`}
            >
              <Icon className="mb-1 h-5 w-5" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}





