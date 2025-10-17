import { ArrowPathIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useHubInfo } from "./hooks/useHubInfo";
import { useGeolocation } from "./hooks/useGeolocation";
import { useLocalWeather } from "./hooks/useLocalWeather";
import { useMockTelemetry } from "./hooks/useMockTelemetry";
import { useWateringRecommendation, WateringRecommendationState } from "./hooks/useWateringRecommendation";
import { CorsOriginsCard } from "./components/CorsOriginsCard";
import { MqttDiagnostics } from "./components/MqttDiagnostics";
import { PageShell } from "./components/PageShell";
import { StatusCard } from "./components/StatusCard";
import { TelemetryChart } from "./components/TelemetryChart";
import { TelemetrySummary } from "./components/TelemetrySummary";
import { TelemetryTable } from "./components/TelemetryTable";
import { WateringRecommendationCard } from "./components/WateringRecommendationCard";
import { LocalConditionsMap } from "./components/LocalConditionsMap";
import { MyPlantsTab } from "./components/MyPlantsTab";
import { ConnectionBadges } from "./components/ConnectionBadges";
import { SettingsPanel } from "./components/SettingsPanel";
import { usePumpControl, type UsePumpControlResult } from "./hooks/usePumpControl";
import { useSensorRead } from "./hooks/useSensorRead";
import { getSettings } from "./settings";

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
    <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-slate-300">
      <span className="inline-flex h-3 w-3 animate-ping rounded-full bg-brand-400" />
      {message}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-6 text-rose-200">
      <h2 className="text-lg font-semibold">Unable to reach the hub</h2>
      <p className="mt-2 text-sm text-rose-100/80">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-rose-500 px-4 py-2 text-sm font-medium text-white hover:bg-rose-400"
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
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
        <h3 className="text-base font-semibold text-slate-200">Location access unavailable</h3>
        <p className="mt-2">
          This browser does not support geolocation, so we cannot load nearby weather stations automatically.
        </p>
      </section>
    );
  }

  if (status === "pending") {
    return <LoadingState message="Requesting location permission..." />;
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
      <h3 className="text-base font-semibold text-slate-200">Enable location services</h3>
      <p className="mt-2">
        Allow access to your approximate location so we can pull real-time conditions from the closest public weather
        station. Coordinates stay on your device and are only sent to the hub to resolve the station.
      </p>
      {error ? <p className="mt-2 text-rose-300">{error}</p> : null}
      <button
        type="button"
        onClick={onEnable}
        className="mt-4 inline-flex items-center gap-2 rounded-lg border border-brand-500/60 bg-brand-500/20 px-4 py-2 text-sm font-medium text-brand-200 hover:bg-brand-500/30"
      >
        Grant Location Access
      </button>
    </section>
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
    <label className="flex items-center gap-3 text-sm text-slate-300">
      <span className="text-slate-400">Range</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value) as LocalRange)}
        className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500"
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

export default function App() {
  const { data, loading, error, refresh } = useHubInfo();
  const { data: telemetry, latest, refresh: refreshTelemetry } = useMockTelemetry(24);
  const watering = useWateringRecommendation(telemetry, DEFAULT_WATERING_OPTIONS);
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
    refresh: refreshLocal,
  } = useLocalWeather(geolocation.coords, localRange, { maxSamples: 200 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverHint, setServerHint] = useState<string>(() => getSettings().serverBaseUrl);

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
  };

  const handleCloseSettings = () => {
    setSettingsOpen(false);
    try {
      const current = getSettings().serverBaseUrl;
      if (current !== serverHint) {
        setServerHint(current);
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

  const chartContent = useMemo(() => {
    if (activeChartTab === "plant") {
      return (
        <TelemetryChart
          data={telemetry}
          title="Plant Conditions"
          subtitle="Live mock data collected from the hub sensors."
        />
      );
    }

    if (activeChartTab === "control") {
      return <PlantControlPanel states={controlStates} onToggle={toggleControl} watering={watering} />;
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
      const subtitle =
        localLatest?.station
          ? `Nearest station: ${localLatest.station}${coverageLabel ? ` - ${coverageLabel}` : ""}`
          : coverageLabel ?? "Live observations from public data.";

      return (
        <div className="space-y-4">
          <TelemetryChart data={localWeather} title="Local Area Conditions" subtitle={subtitle} />
          {geolocation.coords ? (
            <LocalConditionsMap lat={geolocation.coords.lat} lon={geolocation.coords.lon} />
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
    telemetry,
    coverageHours,
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
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
          >
            <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
            title="Settings"
          >
            <Cog6ToothIcon className="h-4 w-4" aria-hidden="true" />
            Settings
          </button>
        </div>
      }
    >
      <div className="space-y-8">
        {loading ? <LoadingState /> : null}
        {!loading && error ? <ErrorState message={error} onRetry={handleRefresh} /> : null}
        {!loading && data ? (
          <>
            <StatusCard info={data} />

            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex rounded-xl bg-slate-900/60 p-1 text-sm font-medium text-slate-300">
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
                {activeChartTab === "local" && geolocation.coords ? (
                  <LocalRangeSelector
                    value={localRange}
                    options={availableRangeOptions as LocalRange[]}
                    onChange={setLocalRange}
                  />
                ) : null}
              </div>
              {activeChartTab === "myplants" ? <MyPlantsTab /> : chartContent}
            </section>

            {activeChartTab === "plant" ? (
              <>
                <TelemetrySummary latest={latest} />
                <div className="grid gap-6 lg:grid-cols-3">
                  <div className="space-y-6 lg:col-span-2">
                    <MqttDiagnostics info={data} />
                    <TelemetryTable data={telemetry} />
                  </div>
                  <CorsOriginsCard origins={data.cors_origins} />
                </div>
              </>
            ) : activeChartTab === "local" && geolocation.coords && localWeather.length ? (
              <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
                <h3 className="text-base font-semibold text-slate-200">Latest Local Observation</h3>
                <p className="mt-2">
                  {localLatest?.timestamp ? new Date(localLatest.timestamp).toLocaleString() : "Timestamp unavailable"}
                </p>
                <ul className="mt-4 space-y-1 text-slate-200">
                  <li>Temperature: {formatMaybeNumber(localLatest?.temperature_c, 1)} deg C</li>
                  <li>Humidity: {formatMaybeNumber(localLatest?.humidity_pct, 1)} %</li>
                  <li>Pressure: {formatMaybeNumber(localLatest?.pressure_hpa, 1)} hPa</li>
                  <li>Solar Radiation: {formatMaybeNumber(localLatest?.solar_radiation_w_m2, 1)} W/m2</li>
                </ul>
              </section>
            ) : null}
          </>
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
}: {
  states: ControlStates;
  onToggle: (id: ControlDeviceId) => void;
  watering: WateringRecommendationState;
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
        const label = snapshotTimestampLabel(sensorRead.data.timestamp, sensorRead.data.timestampMs ?? null);
        setFeedback({
          type: "success",
          message: label ? `Snapshot captured ${label}.` : "Snapshot captured.",
        });
      }
    }
  }, [sensorRead.data, sensorRead.loading, sensorRead.requestId]);

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
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex-1">
              <h3 className="text-base font-semibold text-slate-200">Manual Controls</h3>
              <p className="mt-1 text-xs text-slate-400">
                Manual overrides are simulated for now. Once the hub identifies your pot, it will only surface the
                outputs that are available.
              </p>
            </div>
            <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={handleSensorSubmit}>
              <label className="flex flex-col text-xs text-slate-400 sm:text-right">
                Pot ID
                <input
                  type="text"
                  value={sensorPotId}
                  onChange={(event) => setSensorPotId(event.target.value)}
                  placeholder="e.g. pot-1"
                  className="mt-1 min-w-[12rem] rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/60"
                />
              </label>
              <button
                type="submit"
                title="Send an on-demand sensor_read command to the hub"
                disabled={isSubmitDisabled}
                className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  isSubmitDisabled
                    ? "cursor-not-allowed border border-slate-700 bg-slate-800/70 text-slate-500"
                    : "border border-brand-500/70 bg-brand-500/20 text-brand-100 hover:border-brand-400 hover:bg-brand-500/30"
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
          </div>
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
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-300 sm:col-span-2 xl:col-span-3">
              <h4 className="text-sm font-semibold text-slate-200">Sensor Snapshot</h4>
              {sensorSnapshot ? (
                <>
                  <dl className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-slate-500">Soil moisture</dt>
                      <dd className="text-sm text-slate-100">{applyUnit(moistureValue, "%")}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-slate-500">Temperature</dt>
                      <dd className="text-sm text-slate-100">{applyUnit(temperatureValue, "deg C")}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-slate-500">Humidity</dt>
                      <dd className="text-sm text-slate-100">{applyUnit(humidityValue, "%")}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-slate-500">Flow rate</dt>
                      <dd className="text-sm text-slate-100">{applyUnit(flowRateValue, "L/min")}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-slate-500">Valve</dt>
                      <dd className="text-sm text-slate-100">{valveDisplay}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-slate-500">Reservoir float</dt>
                      <dd className="text-sm text-slate-100">{reservoirDisplay}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-slate-500">Cutoff float</dt>
                      <dd className="text-sm text-slate-100">{cutoffDisplay}</dd>
                    </div>
                    <div>
                      <dt className="text-[10px] uppercase tracking-wide text-slate-500">Soil raw reading</dt>
                      <dd className="text-sm text-slate-100">{soilRawDisplay}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-[11px] text-slate-500">
                    {snapshotTimestamp ? `Received ${snapshotTimestamp}` : "Timestamp unavailable"}
                    {sensorRead.requestId ? ` - Request ${sensorRead.requestId}` : ""}
                    {potIdDisplay ? ` - Pot ${potIdDisplay}` : ""}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-xs text-slate-500">
                  No on-demand snapshot yet. Enter a pot id and press Sensor Read to fetch one.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>
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
    ? "border-brand-400/80 bg-brand-500/20 text-brand-100 shadow shadow-brand-900/40 hover:border-brand-300"
    : "border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700 hover:text-slate-100";
  const statusClasses = isOn
    ? "border border-brand-400/60 bg-brand-500/20 text-brand-100"
    : "border border-slate-700 bg-slate-800 text-slate-400";
  const helperClasses = isOn ? "text-brand-200/80" : "text-slate-400";

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
      className={`rounded-lg px-4 py-2 transition-colors ${
        isActive ? "bg-slate-800 text-slate-100 shadow" : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {label}
    </button>
  );
}
