import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { CollapsibleTile } from "./CollapsibleTile";
import {
  PlantControlSchedule,
  PlantControlScheduleUpdate,
  WateringRecommendation,
  fetchPlantControlSchedule,
  updatePlantControlSchedule,
} from "../api/hubClient";

type Props = {
  recommendation: WateringRecommendation | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  potId?: string | null;
  potLabel?: string | null;
};

const TILE_ID = "plant-control-plant-schedule";
const HEADING = "Plant Schedule";

const SCHEDULE_RANGE_OPTIONS = [
  { key: "1w", label: "1 week", days: 7 },
  { key: "2w", label: "2 weeks", days: 14 },
  { key: "1m", label: "1 month", days: 30 },
  { key: "1y", label: "1 year", days: 365 },
] as const;

type ScheduleRangeKey = (typeof SCHEDULE_RANGE_OPTIONS)[number]["key"];

type WateringCalendarEvent = {
  id: string;
  timeLabel: string;
  volumeLabel: string;
};

type WateringCalendarDay = {
  id: string;
  label: string;
  inMonth: boolean;
  inRange: boolean;
  dateLabel: string;
  times: string[];
  events: WateringCalendarEvent[];
};

type WateringCalendarMonth = {
  id: string;
  label: string;
  weeks: WateringCalendarDay[][];
};

const AVAILABLE_ACTUATORS = ["pump", "mister", "fan", "light", "feeder"] as const;
type ActuatorId = (typeof AVAILABLE_ACTUATORS)[number];

const TIMER_DEVICE_OPTIONS = [
  { id: "light", label: "Lights" },
  { id: "pump", label: "Pumps" },
  { id: "mister", label: "Mister" },
  { id: "fan", label: "Fans" },
] as const;
type TimerDeviceId = (typeof TIMER_DEVICE_OPTIONS)[number]["id"];
const HHMM_TIMER_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

type DeviceTimer = {
  enabled: boolean;
  startTime: string;
  endTime: string;
};

type DeviceTimers = Record<TimerDeviceId, DeviceTimer>;

type WateringDayOverride = {
  volumeMl: number | null;
  eventsPerDay: number;
  durationSeconds: number;
  times: string[];
  actuators: ActuatorId[];
};

function createDefaultDeviceTimers(): DeviceTimers {
  return {
    light: { enabled: false, startTime: "06:00", endTime: "20:00" },
    pump: { enabled: false, startTime: "07:00", endTime: "07:15" },
    mister: { enabled: false, startTime: "08:00", endTime: "08:15" },
    fan: { enabled: false, startTime: "09:00", endTime: "18:00" },
  };
}

function cloneDeviceTimers(timers: DeviceTimers): DeviceTimers {
  return TIMER_DEVICE_OPTIONS.reduce((acc, device) => {
    acc[device.id] = { ...timers[device.id] };
    return acc;
  }, {} as DeviceTimers);
}

function areDeviceTimersEqual(left: DeviceTimers, right: DeviceTimers): boolean {
  return TIMER_DEVICE_OPTIONS.every((device) => {
    const leftTimer = left[device.id];
    const rightTimer = right[device.id];
    return (
      leftTimer.enabled === rightTimer.enabled &&
      leftTimer.startTime === rightTimer.startTime &&
      leftTimer.endTime === rightTimer.endTime
    );
  });
}

function normalizeTimerValue(value: string, fallback: string): string {
  const candidate = value.trim();
  return HHMM_TIMER_PATTERN.test(candidate) ? candidate : fallback;
}

function deviceTimersFromSchedule(schedule: PlantControlSchedule): DeviceTimers {
  const defaults = createDefaultDeviceTimers();
  return {
    light: {
      enabled: schedule.light.enabled,
      startTime: normalizeTimerValue(schedule.light.startTime, defaults.light.startTime),
      endTime: normalizeTimerValue(schedule.light.endTime, defaults.light.endTime),
    },
    pump: {
      enabled: schedule.pump.enabled,
      startTime: normalizeTimerValue(schedule.pump.startTime, defaults.pump.startTime),
      endTime: normalizeTimerValue(schedule.pump.endTime, defaults.pump.endTime),
    },
    mister: {
      enabled: schedule.mister?.enabled ?? defaults.mister.enabled,
      startTime: normalizeTimerValue(schedule.mister?.startTime ?? "", defaults.mister.startTime),
      endTime: normalizeTimerValue(schedule.mister?.endTime ?? "", defaults.mister.endTime),
    },
    fan: {
      enabled: schedule.fan.enabled,
      startTime: normalizeTimerValue(schedule.fan.startTime, defaults.fan.startTime),
      endTime: normalizeTimerValue(schedule.fan.endTime, defaults.fan.endTime),
    },
  };
}

function schedulePayloadFromDeviceTimers(timers: DeviceTimers): PlantControlScheduleUpdate {
  return {
    light: {
      enabled: timers.light.enabled,
      startTime: normalizeTimerValue(timers.light.startTime, "06:00"),
      endTime: normalizeTimerValue(timers.light.endTime, "20:00"),
    },
    pump: {
      enabled: timers.pump.enabled,
      startTime: normalizeTimerValue(timers.pump.startTime, "07:00"),
      endTime: normalizeTimerValue(timers.pump.endTime, "07:15"),
    },
    mister: {
      enabled: timers.mister.enabled,
      startTime: normalizeTimerValue(timers.mister.startTime, "08:00"),
      endTime: normalizeTimerValue(timers.mister.endTime, "08:15"),
    },
    fan: {
      enabled: timers.fan.enabled,
      startTime: normalizeTimerValue(timers.fan.startTime, "09:00"),
      endTime: normalizeTimerValue(timers.fan.endTime, "18:00"),
    },
  };
}

export function WateringRecommendationCard({ recommendation, loading, error, onRetry, potId, potLabel }: Props) {
  const potScopeId = (potId ?? "").trim().toLowerCase() || "__unassigned-pot__";
  const activePotLabel = (potLabel ?? "").trim() || (potId ?? "").trim() || "Unassigned pot";
  const [scheduleRangeByPot, setScheduleRangeByPot] = useState<Record<string, ScheduleRangeKey>>({});
  const [editingDay, setEditingDay] = useState<WateringCalendarDay | null>(null);
  const [dayOverridesByPot, setDayOverridesByPot] = useState<Record<string, Record<string, WateringDayOverride>>>({});
  const [deviceTimersByPot, setDeviceTimersByPot] = useState<Record<string, DeviceTimers>>({});
  const [savedDeviceTimersByPot, setSavedDeviceTimersByPot] = useState<Record<string, DeviceTimers>>({});
  const [hydratedPots, setHydratedPots] = useState<Record<string, boolean>>({});
  const [loadingTimersByPot, setLoadingTimersByPot] = useState<Record<string, boolean>>({});
  const [timerSyncErrorByPot, setTimerSyncErrorByPot] = useState<Record<string, string | null>>({});
  const [timerSaveFeedback, setTimerSaveFeedback] = useState<string | null>(null);
  const [timerSavePending, setTimerSavePending] = useState(false);
  const scheduleRange = scheduleRangeByPot[potScopeId] ?? "1w";
  const dayOverrides = useMemo(() => dayOverridesByPot[potScopeId] ?? {}, [dayOverridesByPot, potScopeId]);
  const isPotHydrated = hydratedPots[potScopeId] ?? false;
  const isTimerScheduleLoading = loadingTimersByPot[potScopeId] ?? false;
  const timerSyncError = timerSyncErrorByPot[potScopeId] ?? null;
  const deviceTimers = useMemo(
    () => deviceTimersByPot[potScopeId] ?? createDefaultDeviceTimers(),
    [deviceTimersByPot, potScopeId]
  );
  const savedDeviceTimers = useMemo(
    () => savedDeviceTimersByPot[potScopeId] ?? createDefaultDeviceTimers(),
    [savedDeviceTimersByPot, potScopeId]
  );
  const hasUnsavedTimerChanges = useMemo(
    () => !areDeviceTimersEqual(deviceTimers, savedDeviceTimers),
    [deviceTimers, savedDeviceTimers]
  );
  const canSaveTimers = Boolean((potId ?? "").trim()) && !isTimerScheduleLoading && !timerSavePending;
  const setScheduleRange = (value: ScheduleRangeKey) => {
    setScheduleRangeByPot((prev) => ({ ...prev, [potScopeId]: value }));
  };
  useEffect(() => {
    setEditingDay(null);
    setTimerSaveFeedback(null);
  }, [potScopeId]);
  useEffect(() => {
    if (!timerSaveFeedback) {
      return;
    }
    const timer = window.setTimeout(() => setTimerSaveFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [timerSaveFeedback]);
  useEffect(() => {
    const trimmedPotId = (potId ?? "").trim();
    if (!trimmedPotId || isPotHydrated) {
      return;
    }
    const controller = new AbortController();
    setLoadingTimersByPot((prev) => ({ ...prev, [potScopeId]: true }));
    setTimerSyncErrorByPot((prev) => ({ ...prev, [potScopeId]: null }));
    fetchPlantControlSchedule(trimmedPotId, controller.signal)
      .then((schedule) => {
        if (controller.signal.aborted) {
          return;
        }
        const hubTimers = deviceTimersFromSchedule(schedule);
        setDeviceTimersByPot((prev) => ({ ...prev, [potScopeId]: hubTimers }));
        setSavedDeviceTimersByPot((prev) => ({ ...prev, [potScopeId]: hubTimers }));
        setHydratedPots((prev) => ({ ...prev, [potScopeId]: true }));
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = loadError instanceof Error ? loadError.message : "Unable to load saved timers from hub.";
        setTimerSyncErrorByPot((prev) => ({ ...prev, [potScopeId]: message }));
      })
      .finally(() => {
        setLoadingTimersByPot((prev) => ({ ...prev, [potScopeId]: false }));
      });
    return () => controller.abort();
  }, [isPotHydrated, potId, potScopeId]);
  const rangeOption = useMemo(
    () => SCHEDULE_RANGE_OPTIONS.find((option) => option.key === scheduleRange) ?? SCHEDULE_RANGE_OPTIONS[0],
    [scheduleRange]
  );
  const recommendationOutputs = recommendation?.outputs;
  const eventsPerDay = useMemo(() => {
    const value = recommendationOutputs?.recommended_events_per_day;
    if (Number.isFinite(value)) {
      return Math.min(12, Math.max(1, Math.round(value)));
    }
    return 1;
  }, [recommendationOutputs?.recommended_events_per_day]);
  const targetMlPerEvent =
    recommendationOutputs && Number.isFinite(recommendationOutputs.recommended_ml_per_event)
      ? recommendationOutputs.recommended_ml_per_event
      : null;
  const wateringCalendar = useMemo(
    () => buildWateringCalendar(rangeOption.days, eventsPerDay, targetMlPerEvent, dayOverrides),
    [rangeOption.days, eventsPerDay, targetMlPerEvent, dayOverrides]
  );
  const customDayIds = useMemo(() => new Set(Object.keys(dayOverrides)), [dayOverrides]);

  const subtitle = recommendation
    ? "Penman-Monteith baseline tuned for your pot profile."
    : "Set daily timers for lights, pumps, misters, and fans while watering guidance is pending.";
  const climateSummary = recommendation
    ? `Averages ${formatValue(recommendation.outputs.etc_mm_day, 2)} mm ETc, ${formatValue(
        recommendation.climate.avg_temperature_c,
        1,
      )} deg C, ${formatValue(recommendation.climate.avg_humidity_pct, 0)}% RH over ~${formatValue(
        recommendation.climate.coverage_hours,
        1
      )} h.`
    : null;
  const noticeToneClass = loading
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100/90"
    : error
      ? "border-rose-500/40 bg-rose-500/10 text-rose-100/90"
      : "border-emerald-700/50 bg-[rgba(6,24,16,0.72)] text-emerald-200/80";
  const noticeMessage = loading
    ? "Calculating watering recommendation from recent telemetry. Schedule timers remain editable."
    : error
      ? recommendation
        ? `Unable to refresh the watering recommendation (${error}). Showing the latest result and active schedule timers.`
        : `Unable to compute a watering recommendation right now (${error}). You can still configure schedule timers.`
      : recommendation
        ? "Watering recommendation is available."
        : "No watering recommendation yet. Schedule timers will continue to populate while telemetry catches up.";
  const handleDeviceTimerToggle = (deviceId: TimerDeviceId) => {
    setTimerSaveFeedback(null);
    setDeviceTimersByPot((prev) => {
      const current = prev[potScopeId] ?? createDefaultDeviceTimers();
      return {
        ...prev,
        [potScopeId]: {
          ...current,
          [deviceId]: { ...current[deviceId], enabled: !current[deviceId].enabled },
        },
      };
    });
  };
  const handleDeviceTimerTimeChange = (
    deviceId: TimerDeviceId,
    field: "startTime" | "endTime",
    value: string
  ) => {
    setTimerSaveFeedback(null);
    setDeviceTimersByPot((prev) => {
      const current = prev[potScopeId] ?? createDefaultDeviceTimers();
      return {
        ...prev,
        [potScopeId]: {
          ...current,
          [deviceId]: { ...current[deviceId], [field]: value },
        },
      };
    });
  };
  const saveDeviceTimers = async () => {
    const trimmedPotId = (potId ?? "").trim();
    if (!trimmedPotId) {
      setTimerSaveFeedback("Select a pot before saving timer changes.");
      return;
    }
    setTimerSavePending(true);
    setTimerSaveFeedback(null);
    setTimerSyncErrorByPot((prev) => ({ ...prev, [potScopeId]: null }));
    try {
      const schedule = await updatePlantControlSchedule(trimmedPotId, schedulePayloadFromDeviceTimers(deviceTimers));
      const persistedTimers = cloneDeviceTimers(deviceTimersFromSchedule(schedule));
      setSavedDeviceTimersByPot((prev) => ({ ...prev, [potScopeId]: persistedTimers }));
      setDeviceTimersByPot((prev) => ({ ...prev, [potScopeId]: persistedTimers }));
      setHydratedPots((prev) => ({ ...prev, [potScopeId]: true }));
      setTimerSaveFeedback(`Saved timer changes for ${activePotLabel}.`);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "Unable to save timers to the hub.";
      setTimerSaveFeedback(message);
      setTimerSyncErrorByPot((prev) => ({ ...prev, [potScopeId]: message }));
    } finally {
      setTimerSavePending(false);
    }
  };
  const handleSaveDeviceTimers = () => {
    void saveDeviceTimers();
  };

  return (
    <CollapsibleTile
      id={TILE_ID}
      title={HEADING}
      subtitle={subtitle}
      className="p-6 text-sm text-emerald-100/85"
      bodyClassName="mt-4 space-y-4"
      actions={
        <button
          type="button"
          onClick={onRetry}
          className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
            error
              ? "border border-rose-400/70 text-rose-50 hover:bg-rose-500/20"
              : "border border-emerald-500/50 bg-emerald-500/15 text-emerald-50 hover:border-emerald-400 hover:bg-emerald-500/25"
          }`}
        >
          <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
          {error ? "Retry" : "Refresh"}
        </button>
      }
    >
      <div className={`rounded-xl border px-3 py-2 text-xs shadow-inner shadow-emerald-950/30 ${noticeToneClass}`}>
        {noticeMessage}
      </div>
      <div className="rounded-xl border border-emerald-700/50 bg-[rgba(6,24,16,0.72)] px-3 py-2 text-xs text-emerald-200/80">
        Managing schedule for {activePotLabel}.
      </div>

      <WateringScheduleCalendar
        rangeKey={scheduleRange}
        rangeLabel={rangeOption.label}
        months={wateringCalendar}
        eventsPerDay={eventsPerDay}
        targetMlPerEvent={targetMlPerEvent}
        onRangeChange={setScheduleRange}
        onDayClick={(day) => setEditingDay(day)}
        customDayIds={customDayIds}
      />

      <DeviceTimerPanel
        timers={deviceTimers}
        onToggle={handleDeviceTimerToggle}
        onTimeChange={handleDeviceTimerTimeChange}
        onSave={handleSaveDeviceTimers}
        hasUnsavedChanges={hasUnsavedTimerChanges}
        saveFeedback={timerSaveFeedback}
        canSave={canSaveTimers}
        loading={isTimerScheduleLoading}
        isSaving={timerSavePending}
        syncError={timerSyncError}
      />

      {climateSummary ? <p className="text-xs text-emerald-200/70">{climateSummary}</p> : null}

      {recommendation ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Metric
              label="ET0 (mm/day)"
              value={recommendation.outputs.et0_mm_day}
              decimals={2}
              description="Reference evapotranspiration based on a well-watered grass surface."
            />
            <Metric
              label="ETc (mm/day)"
              value={recommendation.outputs.etc_mm_day}
              decimals={2}
              description="Crop-adjusted evapotranspiration for your plant profile."
            />
            <Metric
              label="Target water (L/day)"
              value={recommendation.outputs.daily_water_liters}
              decimals={3}
              description="Estimated water lost per day before irrigation efficiency adjustments."
            />
            <Metric
              label="Adjusted for efficiency (L/day)"
              value={recommendation.outputs.adjusted_daily_liters}
              decimals={3}
              description="Daily water target accounting for the configured system efficiency."
            />
            <Metric
              label="Events per day"
              value={recommendation.outputs.recommended_events_per_day}
              decimals={2}
              description="Suggested number of irrigation cycles to distribute the daily volume."
            />
            <Metric
              label="Per irrigation (mL)"
              value={recommendation.outputs.recommended_ml_per_event}
              decimals={0}
              description="Volume to apply each cycle so the pot refills without overflow."
            />
          </div>

          <div className="grid gap-4 text-xs text-emerald-200/70 sm:grid-cols-2">
            <div>
              <h4 className="text-sm font-semibold text-emerald-50">Pot profile</h4>
              <ul className="mt-2 space-y-1">
                <li>
                  Diameter {formatValue(recommendation.pot.diameter_cm, 0)} cm / Height {formatValue(recommendation.pot.height_cm, 0)} cm
                </li>
                <li>Available water fraction {formatValue(recommendation.pot.available_water_fraction * 100, 0)}%</li>
                <li>Irrigation efficiency {formatValue(recommendation.pot.irrigation_efficiency * 100, 0)}%</li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold text-emerald-50">Storage estimates</h4>
              <ul className="mt-2 space-y-1">
                <li>Surface area {formatValue(recommendation.pot_metrics.surface_area_m2, 3)} m^2</li>
                <li>Container volume {formatValue(recommendation.pot_metrics.volume_liters, 2)} L</li>
                <li>
                  Max per event {formatValue(recommendation.pot_metrics.max_event_liters * 1000, 0)} mL (
                  {formatValue(recommendation.pot_metrics.max_event_liters, 3)} L)
                </li>
              </ul>
            </div>
          </div>

          {recommendation.diagnostics.notes.length ? (
            <div className="rounded-2xl border border-emerald-800/40 bg-[rgba(6,24,16,0.78)] p-3 text-xs text-emerald-200/70 shadow-inner shadow-emerald-950/40">
              <p className="font-semibold text-emerald-50">Diagnostics</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {recommendation.diagnostics.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="rounded-xl border border-emerald-700/50 bg-[rgba(6,24,16,0.72)] px-3 py-2 text-xs text-emerald-200/80">
          Watering recommendation details will appear once temperature and humidity telemetry is available.
        </p>
      )}

      {editingDay ? (
        <WateringDayModal
          day={editingDay}
          defaultVolumeMl={targetMlPerEvent}
          defaultEventsPerDay={eventsPerDay}
          existingOverride={dayOverrides[editingDay.id]}
          onClose={() => setEditingDay(null)}
          onSave={(override) => {
            setDayOverridesByPot((prev) => ({
              ...prev,
              [potScopeId]: { ...(prev[potScopeId] ?? {}), [editingDay.id]: override },
            }));
            setEditingDay(null);
          }}
        />
      ) : null}
    </CollapsibleTile>
  );
}

type WateringScheduleCalendarProps = {
  rangeKey: ScheduleRangeKey;
  rangeLabel: string;
  months: WateringCalendarMonth[];
  eventsPerDay: number;
  targetMlPerEvent: number | null;
  onRangeChange: (key: ScheduleRangeKey) => void;
  onDayClick?: (day: WateringCalendarDay) => void;
  customDayIds?: Set<string>;
};

function WateringScheduleCalendar({
  rangeKey,
  rangeLabel,
  months,
  eventsPerDay,
  targetMlPerEvent,
  onRangeChange,
  onDayClick,
  customDayIds,
}: WateringScheduleCalendarProps) {
  const volumeDescriptor =
    targetMlPerEvent !== null ? `${formatValue(targetMlPerEvent, 0)} mL target` : "Target TBD";
  const perDayDescriptor = `${eventsPerDay} event${eventsPerDay === 1 ? "" : "s"}/day`;

  return (
    <div className="rounded-2xl border border-emerald-800/40 bg-[rgba(6,24,16,0.78)] p-4 shadow-inner shadow-emerald-950/40">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-emerald-50">Schedule</p>
          <p className="text-xs text-emerald-200/70">
            {rangeLabel} | {perDayDescriptor} | {volumeDescriptor}
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-emerald-700/60 bg-[rgba(5,22,15,0.75)] p-1 text-xs font-semibold text-emerald-200/80">
          {SCHEDULE_RANGE_OPTIONS.map((option) => {
            const active = option.key === rangeKey;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => onRangeChange(option.key)}
                className={`rounded-md px-3 py-1 transition ${active ? "bg-emerald-500/20 text-emerald-50 shadow-inner shadow-emerald-900/40" : "text-emerald-200/80 hover:text-emerald-50"}`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-4 space-y-4">
        {months.length ? (
          months.map((month) => (
            <div key={month.id} className="overflow-hidden rounded-xl border border-emerald-800/60 bg-[rgba(5,23,16,0.82)] shadow-inner shadow-emerald-950/50">
              <div className="flex items-center justify-between border-b border-emerald-800/60 bg-[rgba(5,22,15,0.8)] px-4 py-3">
                <p className="text-sm font-semibold text-emerald-50">{month.label}</p>
                <p className="text-[11px] uppercase tracking-wide text-emerald-200/70">
                  Sun Mon Tue Wed Thu Fri Sat
                </p>
              </div>
              <div className="px-3 py-3">
                <div className="mb-2 grid grid-cols-7 text-[11px] uppercase tracking-wide text-emerald-200/70">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((dayLabel) => (
                    <span key={dayLabel} className="text-center">{dayLabel}</span>
                  ))}
                </div>
                <div className="space-y-2">
                  {month.weeks.map((week, weekIndex) => (
                    <div key={`${month.id}-week-${weekIndex}`} className="grid grid-cols-7 gap-[1px] rounded-lg border border-emerald-900/60 bg-emerald-900/60">
                      {week.map((day) => {
                        const baseClasses = day.inRange
                          ? "border-emerald-700/60 bg-[rgba(7,32,21,0.85)] text-emerald-50"
                          : "border-emerald-900/60 bg-[rgba(4,16,11,0.7)] text-emerald-800/70";
                        const muted = day.inMonth ? "" : "opacity-60";
                        const clickable = day.inRange && onDayClick;
                        const isCustom = customDayIds?.has(day.id);
                        return (
                          <button
                            type="button"
                            key={day.id}
                            onClick={() => (clickable ? onDayClick?.(day) : undefined)}
                            className={`relative min-h-[96px] border text-left ${baseClasses} ${muted} ${clickable ? "hover:border-emerald-400/70 hover:bg-[rgba(9,40,26,0.9)] focus:outline-none focus:ring-2 focus:ring-emerald-400/60" : ""} p-2`}
                          >
                            <div className="flex items-start justify-between text-xs font-semibold">
                              <span>{day.label}</span>
                              {day.inRange && day.events.length ? (
                                <span className="text-[10px] font-bold text-emerald-200/80">
                                  {day.events.length}x
                                </span>
                              ) : null}
                            </div>
                            {isCustom ? (
                              <span className="absolute right-2 top-2 rounded-full border border-emerald-500/50 bg-emerald-500/15 px-2 py-[2px] text-[10px] font-semibold text-emerald-50 shadow-inner shadow-emerald-900/40">
                                Custom
                              </span>
                            ) : null}
                            <div className="mt-2 space-y-1">
                              {day.events.map((event) => (
                                <div
                                  key={event.id}
                                  className="flex items-center justify-between rounded-md border border-emerald-700/60 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-100"
                                >
                                  <span className="text-emerald-200/80">{event.timeLabel}</span>
                                  <span className="font-semibold text-emerald-50">{event.volumeLabel}</span>
                                </div>
                              ))}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))
        ) : (
          <p className="text-xs text-emerald-200/70">Schedule unavailable for this range.</p>
        )}
      </div>
    </div>
  );
}

type DeviceTimerPanelProps = {
  timers: DeviceTimers;
  onToggle: (deviceId: TimerDeviceId) => void;
  onTimeChange: (deviceId: TimerDeviceId, field: "startTime" | "endTime", value: string) => void;
  onSave: () => void;
  hasUnsavedChanges: boolean;
  saveFeedback: string | null;
  canSave: boolean;
  loading: boolean;
  isSaving: boolean;
  syncError: string | null;
};

function DeviceTimerPanel({
  timers,
  onToggle,
  onTimeChange,
  onSave,
  hasUnsavedChanges,
  saveFeedback,
  canSave,
  loading,
  isSaving,
  syncError,
}: DeviceTimerPanelProps) {
  const displayDate = new Date();
  displayDate.setHours(0, 0, 0, 0);
  const saveDisabled = !hasUnsavedChanges || !canSave;

  return (
    <div className="rounded-2xl border border-emerald-800/40 bg-[rgba(6,24,16,0.78)] p-4 shadow-inner shadow-emerald-950/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-emerald-50">Device Timers</p>
          <p className="text-xs text-emerald-200/70">Set daily start and stop times for lights, pumps, misters, and fans.</p>
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={saveDisabled}
          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
            !saveDisabled
              ? "border-emerald-500/70 bg-emerald-500/20 text-emerald-50 hover:border-emerald-400 hover:bg-emerald-500/30"
              : "cursor-not-allowed border border-emerald-800/60 bg-[rgba(7,28,19,0.78)] text-emerald-200/50"
          }`}
        >
          {isSaving ? "Saving..." : "Save timer changes"}
        </button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {TIMER_DEVICE_OPTIONS.map((device) => {
          const timer = timers[device.id];
          const rangeLabel = timer.enabled
            ? `${formatTimeDisplay(timer.startTime, displayDate)} - ${formatTimeDisplay(timer.endTime, displayDate)}`
            : "Disabled";
          return (
            <div
              key={device.id}
              className="rounded-xl border border-emerald-800/60 bg-[rgba(5,23,16,0.82)] p-3 shadow-inner shadow-emerald-950/50"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-emerald-50">{device.label}</p>
                <button
                  type="button"
                  aria-pressed={timer.enabled}
                  onClick={() => onToggle(device.id)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition ${
                    timer.enabled
                      ? "border-emerald-400/80 bg-emerald-500/20 text-emerald-50"
                      : "border-emerald-800/70 bg-[rgba(7,28,19,0.78)] text-emerald-200/70 hover:border-emerald-600/60"
                  }`}
                >
                  {timer.enabled ? "On" : "Off"}
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-emerald-200/80">
                <label className="flex flex-col gap-1">
                  Start
                  <input
                    type="time"
                    value={timer.startTime}
                    disabled={!timer.enabled}
                    onChange={(event) => onTimeChange(device.id, "startTime", event.target.value)}
                    className="rounded-lg border border-emerald-700/60 bg-[rgba(7,28,19,0.78)] px-2 py-1.5 text-sm text-emerald-50 shadow-inner shadow-emerald-950/50 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/40 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  End
                  <input
                    type="time"
                    value={timer.endTime}
                    disabled={!timer.enabled}
                    onChange={(event) => onTimeChange(device.id, "endTime", event.target.value)}
                    className="rounded-lg border border-emerald-700/60 bg-[rgba(7,28,19,0.78)] px-2 py-1.5 text-sm text-emerald-50 shadow-inner shadow-emerald-950/50 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/40 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </label>
              </div>
              <p className="mt-2 text-xs text-emerald-200/70">{rangeLabel}</p>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-emerald-200/70">
        {hasUnsavedChanges
          ? "You have unsaved timer changes. Press Save timer changes to keep them for this pot."
          : "Timer changes are saved for this pot."}
      </p>
      {saveFeedback ? (
        <p className="mt-1 text-xs text-emerald-100/90">{saveFeedback}</p>
      ) : null}
      <p className="mt-1 text-xs text-emerald-200/70">
        {loading
          ? "Loading saved timers from the hub..."
          : syncError
            ? `Hub schedule sync issue: ${syncError}`
            : "Saved timers are synced through the hub for this pot."}
      </p>
    </div>
  );
}

function buildWateringCalendar(
  days: number,
  eventsPerDay: number,
  targetMlPerEvent: number | null,
  overrides: Record<string, WateringDayOverride>
): WateringCalendarMonth[] {
  const totalDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  if (!totalDays) {
    return [];
  }
  const eventsEachDay = Math.max(1, Math.round(eventsPerDay));
  const defaultVolumeLabel =
    targetMlPerEvent !== null ? `${formatValue(targetMlPerEvent, 0)} mL target` : "Target TBD";

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + totalDays - 1);

  const eventsByDay = new Map<string, WateringCalendarEvent[]>();
  const timeValuesByDay = new Map<string, string[]>();

  const dateKey = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  for (let i = 0; i < totalDays; i += 1) {
    const dayStart = new Date(start);
    dayStart.setDate(start.getDate() + i);
    const key = dateKey(dayStart);
    const dayId = `${dayStart.getTime()}`;
    const override = overrides[key];
    const count = override?.eventsPerDay ?? eventsEachDay;
    const defaultTimes = generateEvenTimeValues(count);
    const timeValues = override?.times?.length
      ? normalizeTimeValues(override.times, count, defaultTimes)
      : defaultTimes;
    const volumeLabel =
      override && override.volumeMl !== null && override.volumeMl !== undefined
        ? `${formatValue(override.volumeMl, 0)} mL target`
        : defaultVolumeLabel;
    const fallbackTimeLabels = generateEvenTimeValues(count).map((value) => formatTimeDisplay(value, dayStart));
    const events: WateringCalendarEvent[] = Array.from({ length: count }).map((_, eventIndex) => {
      const timeLabel =
        formatTimeDisplay(timeValues[eventIndex] ?? fallbackTimeLabels[eventIndex] ?? "", dayStart) ??
        fallbackTimeLabels[eventIndex] ??
        "Set time";
      return {
        id: `${dayId}-${eventIndex}`,
        timeLabel,
        volumeLabel,
      };
    });
    eventsByDay.set(key, events);
    timeValuesByDay.set(key, timeValues);
  }

  const months: WateringCalendarMonth[] = [];
  const monthCursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (monthCursor <= end) {
    const monthId = `${monthCursor.getFullYear()}-${String(monthCursor.getMonth() + 1).padStart(2, "0")}`;
    const monthLabel = monthCursor.toLocaleDateString([], { month: "long", year: "numeric" });
    const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate();
    const firstDayOfWeek = new Date(monthCursor);
    const leadingEmpty = firstDayOfWeek.getDay();
    const totalCells = Math.ceil((leadingEmpty + daysInMonth) / 7) * 7;
    const weeks: WateringCalendarDay[][] = [];
    const cellCursor = new Date(monthCursor);
    cellCursor.setDate(1 - leadingEmpty);

    for (let cellIndex = 0; cellIndex < totalCells; cellIndex += 1) {
      const current = new Date(cellCursor);
      const key = dateKey(current);
      const inMonth = current.getMonth() === monthCursor.getMonth();
      const inRange = current >= start && current <= end;
      const label = current.getDate().toString();
      const events = inRange ? eventsByDay.get(key) ?? [] : [];
      const timeValues = inRange ? timeValuesByDay.get(key) ?? [] : [];
      const day: WateringCalendarDay = {
        id: `${key}`,
        label,
        dateLabel: current.toDateString(),
        inMonth,
        inRange,
        times: timeValues,
        events,
      };
      const weekIndex = Math.floor(cellIndex / 7);
      if (!weeks[weekIndex]) {
        weeks[weekIndex] = [];
      }
      weeks[weekIndex].push(day);
      cellCursor.setDate(cellCursor.getDate() + 1);
    }

    months.push({ id: monthId, label: monthLabel, weeks });
    monthCursor.setMonth(monthCursor.getMonth() + 1, 1);
  }

  return months;
}

function generateEvenTimeValues(count: number): string[] {
  const safeCount = Math.max(1, count);
  const intervalMinutes = 1440 / safeCount;
  return Array.from({ length: safeCount }).map((_, index) => {
    const minutesIntoDay = Math.round(index * intervalMinutes + intervalMinutes / 2);
    const hours = Math.floor(minutesIntoDay / 60) % 24;
    const minutes = minutesIntoDay % 60;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
  });
}

function normalizeTimeValues(times: string[], count: number, fallback: string[]): string[] {
  const normalizedFallback = fallback.length >= count ? fallback.slice(0, count) : generateEvenTimeValues(count);
  const result = normalizedFallback.slice();
  for (let i = 0; i < count; i += 1) {
    const value = times[i];
    if (typeof value === "string" && value.trim()) {
      result[i] = value.trim();
    }
  }
  return result;
}

function formatTimeDisplay(value: string, baseDate: Date): string {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return "Set time";
  }

  const hhmm = trimmed.match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (hhmm) {
    let hours = Number.parseInt(hhmm[1], 10);
    const minutes = Number.parseInt(hhmm[2], 10);
    const meridiem = hhmm[3]?.toLowerCase() ?? null;
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    const date = new Date(baseDate);
    date.setHours(hours, minutes, 0, 0);
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  return trimmed;
}

function formatValue(value: number, decimals: number) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(decimals);
}

type WateringDayModalProps = {
  day: WateringCalendarDay;
  defaultVolumeMl: number | null;
  defaultEventsPerDay: number;
  existingOverride?: WateringDayOverride;
  onClose: () => void;
  onSave: (override: WateringDayOverride) => void;
};

function WateringDayModal({
  day,
  defaultVolumeMl,
  defaultEventsPerDay,
  existingOverride,
  onClose,
  onSave,
}: WateringDayModalProps) {
  const initialEvents = existingOverride?.eventsPerDay ?? day.events.length ?? defaultEventsPerDay ?? 1;
  const [volumeInput, setVolumeInput] = useState(
    existingOverride?.volumeMl !== null && existingOverride?.volumeMl !== undefined
      ? existingOverride.volumeMl.toString()
      : defaultVolumeMl !== null && defaultVolumeMl !== undefined
        ? defaultVolumeMl.toString()
        : ""
  );
  const [eventsCount, setEventsCount] = useState(Math.max(1, initialEvents));
  const [durationSeconds, setDurationSeconds] = useState(existingOverride?.durationSeconds ?? 60);
  const [times, setTimes] = useState<string[]>(() => {
    const defaults = generateEvenTimeValues(Math.max(1, initialEvents));
    const baseTimes =
      existingOverride?.times?.length ? existingOverride.times : day.times.length ? day.times : defaults;
    return normalizeTimeValues(baseTimes, Math.max(1, initialEvents), defaults);
  });
  const [actuators, setActuators] = useState<Set<ActuatorId>>(
    () => new Set(existingOverride?.actuators ?? ["pump"])
  );

  const handleEventsChange = (value: number) => {
    const next = Number.isFinite(value) && value > 0 ? Math.min(24, Math.round(value)) : 1;
    setEventsCount(next);
    setTimes((prev) => normalizeTimeValues(prev, next, generateEvenTimeValues(next)));
  };

  const handleTimeChange = (index: number, value: string) => {
    setTimes((prev) => {
      const next = prev.slice();
      next[index] = value;
      return normalizeTimeValues(next, eventsCount, generateEvenTimeValues(eventsCount));
    });
  };

  const handleActuatorToggle = (id: ActuatorId) => {
    setActuators((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSave = () => {
    const volumeValue = Number.parseFloat(volumeInput);
    const volumeMl = Number.isFinite(volumeValue) ? volumeValue : null;
    const cleanTimes = normalizeTimeValues(times, eventsCount, generateEvenTimeValues(eventsCount));
    onSave({
      volumeMl,
      eventsPerDay: eventsCount,
      durationSeconds: Math.max(1, Math.round(durationSeconds)),
      times: cleanTimes,
      actuators: Array.from(actuators),
    });
  };

  const handleRegenerateTimes = () => {
    setTimes(generateEvenTimeValues(eventsCount));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8">
      <div className="w-full max-w-3xl rounded-2xl border border-emerald-700/60 bg-[rgba(3,15,10,0.96)] shadow-[0_40px_120px_rgba(2,12,8,0.8)]">
        <div className="flex items-center justify-between border-b border-emerald-800/60 px-6 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.28em] text-emerald-200/60">Day Plan</p>
            <h2 className="text-lg font-semibold text-emerald-50">{day.dateLabel}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-emerald-700/60 px-3 py-1.5 text-sm text-emerald-200/80 transition hover:border-emerald-500/60 hover:bg-emerald-500/10"
          >
            Close
          </button>
        </div>

        <div className="space-y-6 px-6 py-5 text-sm text-emerald-100/85">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-emerald-200/70">Target water volume (mL)</span>
              <input
                type="number"
                value={volumeInput}
                onChange={(event) => setVolumeInput(event.target.value)}
                placeholder="e.g. 120"
                className="rounded-lg border border-emerald-700/60 bg-[rgba(7,28,19,0.78)] px-3 py-2 text-emerald-50 shadow-inner shadow-emerald-950/50 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/40"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-emerald-200/70">Events per day</span>
              <input
                type="number"
                min={1}
                max={24}
                value={eventsCount}
                onChange={(event) => handleEventsChange(Number(event.target.value))}
                className="rounded-lg border border-emerald-700/60 bg-[rgba(7,28,19,0.78)] px-3 py-2 text-emerald-50 shadow-inner shadow-emerald-950/50 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/40"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wide text-emerald-200/70">Duration per event (seconds)</span>
              <input
                type="number"
                min={1}
                max={3600}
                value={durationSeconds}
                onChange={(event) => setDurationSeconds(Number(event.target.value))}
                className="rounded-lg border border-emerald-700/60 bg-[rgba(7,28,19,0.78)] px-3 py-2 text-emerald-50 shadow-inner shadow-emerald-950/50 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/40"
              />
            </label>
          </div>

          <div className="rounded-xl border border-emerald-800/60 bg-[rgba(5,23,16,0.82)] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-emerald-50">Times</p>
                <p className="text-xs text-emerald-200/70">Set specific run times for this day.</p>
              </div>
              <button
                type="button"
                onClick={handleRegenerateTimes}
                className="rounded-lg border border-emerald-600/60 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-100 transition hover:border-emerald-400 hover:bg-emerald-500/20"
              >
                Evenly spread
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: eventsCount }).map((_, index) => (
                <label key={index} className="flex flex-col gap-1 text-xs font-semibold text-emerald-200/80">
                  Event {index + 1}
                  <input
                    type="time"
                    value={times[index] ?? ""}
                    onChange={(event) => handleTimeChange(index, event.target.value)}
                    className="rounded-lg border border-emerald-700/60 bg-[rgba(7,28,19,0.78)] px-3 py-2 text-sm text-emerald-50 shadow-inner shadow-emerald-950/50 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/40"
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-emerald-800/60 bg-[rgba(5,23,16,0.82)] p-4">
            <p className="text-sm font-semibold text-emerald-50">Actuators</p>
            <p className="text-xs text-emerald-200/70">Choose which devices participate for this day.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {AVAILABLE_ACTUATORS.map((id) => {
                const active = actuators.has(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => handleActuatorToggle(id)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-semibold capitalize transition ${
                      active
                        ? "border-emerald-400 bg-emerald-500/20 text-emerald-50"
                        : "border-emerald-800/60 bg-[rgba(7,28,19,0.78)] text-emerald-200/70 hover:border-emerald-500/50 hover:text-emerald-100"
                    }`}
                  >
                    {id}
                  </button>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-emerald-200/70">
            These settings update the on-screen plan for this day. Send or sync to the hub once device controls are wired.
          </p>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-emerald-800/50 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-emerald-800/70 px-4 py-2 text-sm font-semibold text-emerald-200/80 transition hover:border-emerald-600/60 hover:bg-emerald-600/10"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/70 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-50 transition hover:border-emerald-400 hover:bg-emerald-500/30"
            >
              Save day plan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type MetricProps = {
  label: string;
  value: number;
  decimals: number;
  description?: string;
};

function Metric({ label, value, decimals, description }: MetricProps) {
  const content = formatValue(value, decimals);
  return (
    <div
      className="group relative rounded-2xl border border-emerald-800/40 bg-[rgba(6,24,16,0.78)] p-3 transition-all focus-within:border-emerald-400/50 focus-within:outline-none focus-within:ring-2 focus-within:ring-emerald-400/40"
      tabIndex={description ? 0 : undefined}
      title={description}
    >
      <p className="text-xs uppercase tracking-wide text-emerald-200/60">{label}</p>
      <p className="mt-1 text-lg font-semibold text-emerald-50">{content}</p>
      {description ? (
        <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-3 w-60 -translate-x-1/2 rounded-lg border border-emerald-700/40 bg-[rgba(4,18,12,0.95)] px-3 py-2 text-xs text-emerald-100 opacity-0 shadow-lg shadow-emerald-950/60 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          {description}
        </div>
      ) : null}
    </div>
  );
}
