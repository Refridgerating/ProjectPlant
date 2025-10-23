import { ArrowDownTrayIcon, ArrowPathIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHubInfo } from "./hooks/useHubInfo";
import { useGeolocation } from "./hooks/useGeolocation";
import { useLocalWeather } from "./hooks/useLocalWeather";
import { useTelemetry } from "./hooks/useTelemetry";
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
import { ConnectionBadges } from "./components/ConnectionBadges";
import { SettingsPanel } from "./components/SettingsPanel";
import { PenmanMonteithEquation } from "./components/PenmanMonteithEquation";
import { CollapsibleTile } from "./components/CollapsibleTile";
import { useSensorRead } from "./hooks/useSensorRead";
import { TelemetrySample, SensorReadPayload, exportPotTelemetry, fetchPotTelemetry } from "./api/hubClient";
import { getSettings, RuntimeMode } from "./settings";

const LOCAL_RANGE_OPTIONS = [
  { label: "30 minutes", value: 0.5 },
  { label: "1 hour", value: 1 },
  { label: "2 hours", value: 2 },
  { label: "6 hours", value: 6 },
  { label: "12 hours", value: 12 },
  { label: "24 hours", value: 24 },
  { label: "48 hours", value: 48 },
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

const CONTROL_DEVICES = [
  { id: "pump", label: "H2O Pump" },
  { id: "fan", label: "Fan" },
  { id: "light", label: "Grow Light" },
  { id: "feeder", label: "Feeder" },
  { id: "mister", label: "Mister" },
] as const;

type ControlDeviceId = (typeof CONTROL_DEVICES)[number]["id"];
type ControlStates = Record<ControlDeviceId, boolean>;
type HubTab = "plant" | "control" | "local" | "myplants";
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

export default function App() {
  const { data, loading, error, refresh } = useHubInfo();
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
  const {
    data: telemetryRaw,
    loading: telemetryLoading,
    error: telemetryError,
    refresh: refreshTelemetry,
  } = useTelemetry({ mode: runtimeMode, samples: 96, hours: 24 });
  const [sensorSeriesByPot, setSensorSeriesByPot] = useState<Record<string, TelemetrySample[]>>({});
  const [telemetrySource, setTelemetrySource] = useState<string>(initialTelemetrySource);
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
    refresh: refreshLocal,
  } = useLocalWeather(geolocation.coords, localRange, { maxSamples: 200 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverHint, setServerHint] = useState<string>(initialSettings.serverBaseUrl);
  const [potTelemetryTicker, setPotTelemetryTicker] = useState(0);
  const [telemetryExporting, setTelemetryExporting] = useState(false);
  const [telemetryExportStatus, setTelemetryExportStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const telemetryExportTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

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

  const telemetryOptions = useMemo<TelemetrySourceOption[]>(() => {
    const identifiers = new Set<string>();
    DEFAULT_TELEMETRY_POTS.forEach((id) => identifiers.add(id));
    Object.keys(sensorSeriesByPot).forEach((id) => identifiers.add(id));
    if (telemetrySource !== "mock" && telemetrySource.trim()) {
      identifiers.add(telemetrySource.trim());
    }
    const potIds = Array.from(identifiers)
      .filter((id) => id.trim().length > 0)
      .sort((a, b) => a.localeCompare(b));
    return [
      { value: "mock", label: "Demo Telemetry" },
      ...potIds.map((potId) => ({ value: potId, label: formatPotLabel(potId) })),
    ];
  }, [sensorSeriesByPot, telemetrySource]);

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
    return mergeTelemetryWithWeather(sensorSeriesByPot[telemetrySource] ?? []);
  }, [telemetrySource, mockTelemetry, sensorSeriesByPot, mergeTelemetryWithWeather]);

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
    const label = formatPotLabel(telemetrySource);
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
    const potLabel = formatPotLabel(telemetrySource);
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
  }, [telemetrySource, telemetryRange, potTelemetryRangeLabel, potTelemetryLimit, showTelemetryExportStatus]);

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
        : `Export telemetry for ${formatPotLabel(telemetrySource)} (${potTelemetryRangeLabel})`;
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
  }, [handleTelemetryExport, telemetryExporting, telemetryExportStatus, telemetrySource, potTelemetryRangeLabel]);

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
    setSensorSeriesByPot((prev) => (prev[normalized] ? prev : { ...prev, [normalized]: [] }));
    const controller = new AbortController();
    setPotTelemetryLoading(true);
    setPotTelemetryError(null);
    fetchPotTelemetry(
      normalized,
      { hours: telemetryRange.hours, limit: potTelemetryLimit },
      controller.signal
    )
      .then((samples) => {
        const ordered = [...samples].sort((a, b) => {
          const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return at - bt;
        });
        setSensorSeriesByPot((prev) => ({ ...prev, [normalized]: ordered }));
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
  }, [telemetrySource, potTelemetryTicker, telemetryRange, potTelemetryLimit]);

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
      const sample: TelemetrySample = {
        timestamp: timestampIso,
        temperature_c: toNumber(snapshot.temperature),
        humidity_pct: toNumber(snapshot.humidity),
        moisture_pct: toNumber(snapshot.moisture),
        pressure_hpa: weatherSnapshot?.pressure_hpa ?? null,
        solar_radiation_w_m2: weatherSnapshot?.solar_radiation_w_m2 ?? null,
        wind_speed_m_s: weatherSnapshot?.wind_speed_m_s ?? null,
        station: potId,
        source: "sensor-snapshot",
      };
      setSensorSeriesByPot((prev) => {
        const existing = prev[potId] ?? [];
        const nextSeries = [...existing, sample].sort((a, b) => {
          const at = new Date(a.timestamp).getTime();
          const bt = new Date(b.timestamp).getTime();
          return at - bt;
        });
        const limit = 200;
        const trimmedSeries = nextSeries.slice(Math.max(0, nextSeries.length - limit));
        return {
          ...prev,
          [potId]: trimmedSeries,
        };
      });
      setTelemetrySource(potId);
    },
    [localWeather]
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

  const title = useMemo(() => (data ? data.name : "ProjectPlant Hub"), [data]);

  const handleRefresh = () => {
    refresh();
    refreshTelemetry();
    if (geolocation.coords) {
      refreshLocal();
    }
    if (telemetrySource !== "mock") {
      setPotTelemetryTicker((prev) => prev + 1);
    }
  };

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
          : `Loading telemetry for ${formatPotLabel(telemetrySource)}...`;
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
            />
          ) : null}
        </div>
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
    refreshLocal,
    displayTelemetry,
    telemetrySource,
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
  ]);

  return (
    <>
    <PageShell
      title={title}
      subtitle="Monitor broker connectivity and hub health as we iterate on the UI."
      actions={
        <div className="flex items-center gap-2">
          <ConnectionBadges rest={{ loading, error, data }} />
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
            ) : activeChartTab === "local" && geolocation.coords && localWeather.length ? (
              <CollapsibleTile
                id="local-conditions-latest-observation"
                title="Latest Local Observation"
                subtitle={localLatest?.timestamp ? new Date(localLatest.timestamp).toLocaleString() : "Timestamp unavailable"}
                className="text-sm text-emerald-100/90"
                bodyClassName="mt-4 space-y-1 text-emerald-100"
                titleClassName="text-base font-semibold text-emerald-50"
                subtitleClassName="text-xs text-emerald-200/70"
              >
                <ul className="space-y-1">
                  <li>Temperature: {formatMaybeNumber(localLatest?.temperature_c, 1)} deg C</li>
                  <li>Humidity: {formatMaybeNumber(localLatest?.humidity_pct, 1)} %</li>
                  <li>Pressure: {formatMaybeNumber(localLatest?.pressure_hpa, 1)} hPa</li>
                  <li>Solar Radiation: {formatMaybeNumber(localLatest?.solar_radiation_w_m2, 1)} W/m^2</li>
                  <li>Wind Speed: {formatMaybeNumber(localLatest?.wind_speed_m_s, 2)} m/s</li>
                </ul>
              </CollapsibleTile>
            ) : null}
          </div>
        ) : null}
      </div>
    </PageShell>
    <SettingsPanel open={settingsOpen} onClose={handleCloseSettings} />
    </>
  );
}

function PlantControlPanel({
  states,
  onToggle,
  watering,
  onSnapshot,
}: {
  states: ControlStates;
  onToggle: (id: ControlDeviceId) => void;
  watering: WateringRecommendationState;
  onSnapshot: (payload: SensorReadPayload) => void;
}) {
  const [sensorPotId, setSensorPotId] = useState("");
  const sensorRead = useSensorRead();
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const lastRequestIdRef = useRef<string | null>(null);

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
    if (sensorRead.requestId && sensorRead.data && !sensorRead.loading) {
      if (lastRequestIdRef.current !== sensorRead.requestId) {
        lastRequestIdRef.current = sensorRead.requestId;
        const fallbackPotId = (sensorRead.data.potId || sensorPotId || "").trim() || "unknown-pot";
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
  }, [sensorPotId, onSnapshot, sensorRead.data, sensorRead.loading, sensorRead.requestId]);

  useEffect(() => {
    if (!feedback) {
      return;
    }
    const timer = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const handleSensorSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = sensorPotId.trim();
    setSensorPotId(trimmed);
    if (!trimmed) {
      setFeedback({
        type: "error",
        message: "Enter a pot id before requesting a sensor read.",
      });
      return;
    }
    setFeedback(null);
    await sensorRead.request({ potId: trimmed });
  };

  const sensorSnapshot = sensorRead.data;
  const trimmedPotId = sensorPotId.trim();
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
  const soilRawDisplay =
    sensorSnapshot && typeof sensorSnapshot.soilRaw === "number" && !Number.isNaN(sensorSnapshot.soilRaw)
      ? sensorSnapshot.soilRaw.toString()
      : "-";
  const reservoirDisplay = describeWaterLow(sensorSnapshot?.waterLow);
  const cutoffDisplay = describeWaterCutoff(sensorSnapshot?.waterCutoff);
  const potIdDisplay = sensorSnapshot?.potId ? sensorSnapshot.potId : null;

  return (
    <div className="space-y-4">
      <WateringRecommendationCard
        recommendation={watering.data}
        loading={watering.loading}
        error={watering.error}
        onRetry={watering.refresh}
      />
      <PenmanMonteithEquation />
      <CollapsibleTile
        id="plant-control-manual-controls"
        title="Manual Controls"
        subtitle="Manual overrides are simulated for now. Once the hub identifies your pot, it will only surface the outputs that are available."
        className="p-4 text-sm text-emerald-100/85"
        bodyClassName="mt-4 space-y-4"
      >
        <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={handleSensorSubmit}>
          <label className="flex flex-col text-xs text-emerald-200/70 sm:text-right">
            Pot ID
            <input
              type="text"
              value={sensorPotId}
              onChange={(event) => setSensorPotId(event.target.value)}
              placeholder="e.g. pot-1"
              className="mt-1 min-w-[12rem] rounded-lg border border-emerald-700/50 bg-[rgba(6,30,20,0.88)] px-3 py-2 text-sm text-emerald-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/60"
            />
          </label>
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
        </form>
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {CONTROL_DEVICES.map((device) => (
              <ControlToggleButton
                key={device.id}
                label={device.label}
                isOn={states[device.id]}
                onClick={() => onToggle(device.id)}
              />
            ))}
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
                  No on-demand snapshot yet. Enter a pot id and press Sensor Read to fetch one.
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
}: {
  label: string;
  isOn: boolean;
  onClick: () => void;
}) {
  const buttonClasses = isOn
    ? "border-emerald-400/80 bg-emerald-500/20 text-emerald-100 shadow shadow-emerald-900/40 hover:border-emerald-300"
    : "border-emerald-900/40 bg-[rgba(7,28,19,0.72)] text-emerald-100/70 hover:border-emerald-700/40 hover:text-emerald-100";
  const statusClasses = isOn
    ? "border border-emerald-400/60 bg-emerald-500/20 text-emerald-100"
    : "border border-emerald-800/40 bg-[rgba(6,24,16,0.78)] text-emerald-200/60";
  const helperClasses = isOn ? "text-emerald-200/80" : "text-emerald-200/60";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-28 flex-col justify-between rounded-xl border px-4 py-3 text-left transition-colors ${buttonClasses}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-base font-semibold">{label}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusClasses}`}>
          {isOn ? "On" : "Off"}
        </span>
      </div>
      <p className={`text-xs ${helperClasses}`}>
        {isOn ? "Manual override engaged" : "Tap to enable manual control"}
      </p>
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
