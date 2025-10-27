
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useEffect, useMemo, useState } from "react";
import { fetchEtkcMetrics } from "../api/hubClient";
import { CollapsibleTile } from "./CollapsibleTile";

const RANGE_OPTIONS = [
  { label: "24 hours", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
] as const;

type RangeOption = (typeof RANGE_OPTIONS)[number];

type WaterModelSectionProps = {
  plantId?: string | null;
};

type ChartDatum = {
  timeValue: number;
  timeLabel: string;
  stepHours: number;
  ET0_mm: number;
  ETc_model_mm: number;
  ETc_obs_mm: number | null;
  residual_mm: number | null;
  ET0_mmh: number;
  ETc_model_mmh: number;
  ETc_obs_mmh: number | null;
  water_applied_mm: number;
  water_applied_mmh: number;
  Kcb_struct: number;
  Kcb_eff: number;
  Ke: number;
  Ks: number;
  De_mm: number;
  Dr_mm: number;
  need_irrigation: boolean;
  recommend_mm: number;
};

type HourlyPoint = {
  timeValue: number;
  timeLabel: string;
  ET0_mmh: number;
  ETc_model_mmh: number;
  ETc_obs_mmh: number | null;
  water_applied_mmh: number;
};

type DailySummary = {
  day: string;
  ET0_mm: number;
  ETc_model_mm: number;
  ETc_obs_mm: number | null;
  observedSamples: number;
};

function formatTimeTick(value: number): string {
  const date = new Date(value);
  return date.toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

function formatResidual(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "-";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} mm`;
}

function computeDailySummaries(metrics: ChartDatum[]): DailySummary[] {
  const map = new Map<string, DailySummary>();
  metrics.forEach((metric) => {
    const date = new Date(metric.timeValue);
    const key = date.toISOString().slice(0, 10);
    const entry = map.get(key) ?? {
      day: key,
      ET0_mm: 0,
      ETc_model_mm: 0,
      ETc_obs_mm: 0,
      observedSamples: 0,
    };
    entry.ET0_mm += metric.ET0_mm;
    entry.ETc_model_mm += metric.ETc_model_mm;
    if (typeof metric.ETc_obs_mm === "number") {
      entry.ETc_obs_mm = (entry.ETc_obs_mm ?? 0) + metric.ETc_obs_mm;
      entry.observedSamples += 1;
    } else if (entry.ETc_obs_mm === null) {
      entry.ETc_obs_mm = null;
    }
    map.set(key, entry);
  });

  const summaries = Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
  return summaries;
}

function computeBadge(summary: DailySummary | null): { label: string; className: string } {
  if (!summary) {
    return { label: "No data", className: "bg-emerald-900/60 text-emerald-200/80 border border-emerald-700/40" };
  }
  if (summary.observedSamples === 0 || summary.ETc_obs_mm === null) {
    return { label: "No observed ET", className: "bg-rose-900/40 text-rose-200 border border-rose-500/40" };
  }
  const residual = Math.abs((summary.ETc_obs_mm ?? 0) - summary.ETc_model_mm);
  const baseline = Math.max(summary.ETc_obs_mm ?? 0, 0.01);
  const ratio = residual / baseline;
  if (ratio <= 0.1) {
    return { label: "GREEN · within 10%", className: "bg-emerald-500/20 text-emerald-100 border border-emerald-400/60" };
  }
  if (ratio <= 0.25) {
    return { label: "YELLOW · 10–25%", className: "bg-amber-500/20 text-amber-100 border border-amber-400/60" };
  }
  return { label: "RED · check model", className: "bg-rose-500/20 text-rose-100 border border-rose-400/60" };
}

export function WaterModelSection({ plantId }: WaterModelSectionProps) {
  const [range, setRange] = useState<RangeOption>(RANGE_OPTIONS[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ChartDatum[]>([]);

  const sinceIso = useMemo(() => {
    if (!plantId) return undefined;
    const sinceMs = Date.now() - range.hours * 3600 * 1000;
    return new Date(sinceMs).toISOString();
  }, [plantId, range]);

  useEffect(() => {
    if (!plantId) {
      setMetrics([]);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    fetchEtkcMetrics(plantId, sinceIso, abort.signal)
      .then((payload) => {
        const mapped: ChartDatum[] = payload
          .map((item) => {
            const timeValue = Number.isFinite(item.ts) ? item.ts * 1000 : Date.now();
            const timeLabel = new Date(timeValue).toISOString();
            const residual =
              item.ETc_obs_mm === null || item.ETc_obs_mm === undefined
                ? null
                : item.ETc_obs_mm - item.ETc_model_mm;
            return {
              timeValue,
              timeLabel,
              stepHours: 0,
              ET0_mm: item.ET0_mm ?? 0,
              ETc_model_mm: item.ETc_model_mm ?? 0,
              ETc_obs_mm: item.ETc_obs_mm ?? null,
              residual_mm: residual,
              ET0_mmh: 0,
              ETc_model_mmh: 0,
              ETc_obs_mmh: item.ETc_obs_mm ?? null,
              water_applied_mm: 0,
              water_applied_mmh: 0,
              Kcb_struct: item.Kcb_struct ?? 0,
              Kcb_eff: item.Kcb_eff ?? 0,
              Ke: item.Ke ?? 0,
              Ks: item.Ks ?? 0,
              De_mm: item.De_mm ?? 0,
              Dr_mm: item.Dr_mm ?? 0,
              need_irrigation: Boolean(item.need_irrigation),
              recommend_mm: item.recommend_mm ?? 0,
            };
          })
          .sort((a, b) => a.timeValue - b.timeValue);

        for (let index = 0; index < mapped.length; index += 1) {
          const current = mapped[index];
          const previous = index > 0 ? mapped[index - 1] : null;
          const next = index < mapped.length - 1 ? mapped[index + 1] : null;
          let deltaHours = 0;
          if (previous) {
            const deltaMs = current.timeValue - previous.timeValue;
            deltaHours = deltaMs > 0 ? deltaMs / (1000 * 3600) : 0;
          } else if (next) {
            const deltaMs = next.timeValue - current.timeValue;
            deltaHours = deltaMs > 0 ? deltaMs / (1000 * 3600) : 0;
          }
          const stepHours = deltaHours > 0 ? deltaHours : 1;
          current.stepHours = stepHours;
          current.ET0_mmh = stepHours > 0 ? current.ET0_mm / stepHours : current.ET0_mm;
          current.ETc_model_mmh = stepHours > 0 ? current.ETc_model_mm / stepHours : current.ETc_model_mm;
          current.ETc_obs_mmh =
            current.ETc_obs_mm !== null && stepHours > 0 ? current.ETc_obs_mm / stepHours : current.ETc_obs_mm;
          if (previous) {
            const netInflow = previous.Dr_mm + current.ETc_model_mm - current.Dr_mm;
            const applied = netInflow > 0 ? netInflow : 0;
            current.water_applied_mm = applied;
            current.water_applied_mmh = stepHours > 0 ? applied / stepHours : applied;
          } else {
            current.water_applied_mm = 0;
            current.water_applied_mmh = 0;
          }
        }
        setMetrics(mapped);
      })
      .catch((err) => {
        if (abort.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load ETc metrics.");
        setMetrics([]);
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [plantId, sinceIso]);

  const dailySummaries = useMemo(() => computeDailySummaries(metrics), [metrics]);
  const latestSummary = dailySummaries.length ? dailySummaries[dailySummaries.length - 1] : null;
  const badge = computeBadge(latestSummary);
  const irrigationEvents = useMemo(
    () =>
      metrics
        .filter((item) => item.need_irrigation && item.recommend_mm > 0)
        .map((item) => ({
          timeValue: item.timeValue,
          recommend_mm: item.recommend_mm,
        })),
    [metrics]
  );
  const hourlySeries = useMemo<HourlyPoint[]>(() => {
    if (!metrics.length) {
      return [];
    }
    const buckets = new Map<
      number,
      {
        hours: number;
        et0_mm: number;
        etc_model_mm: number;
        etc_obs_mm: number;
        obsHours: number;
        water_applied_mm: number;
      }
    >();
    metrics.forEach((entry) => {
      if (!Number.isFinite(entry.timeValue)) {
        return;
      }
      const date = new Date(entry.timeValue);
      const bucketKey = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
      const bucket =
        buckets.get(bucketKey) ??
        {
          hours: 0,
          et0_mm: 0,
          etc_model_mm: 0,
          etc_obs_mm: 0,
          obsHours: 0,
          water_applied_mm: 0,
        };
      bucket.hours += entry.stepHours > 0 ? entry.stepHours : 0;
      bucket.et0_mm += entry.ET0_mm;
      bucket.etc_model_mm += entry.ETc_model_mm;
      if (entry.ETc_obs_mm !== null && entry.ETc_obs_mm !== undefined) {
        bucket.etc_obs_mm += entry.ETc_obs_mm;
        bucket.obsHours += entry.stepHours > 0 ? entry.stepHours : 0;
      }
      bucket.water_applied_mm += entry.water_applied_mm;
      buckets.set(bucketKey, bucket);
    });

    return Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([timeValue, bucket]) => {
        const hours = bucket.hours > 0 ? bucket.hours : 1;
        const obsHours = bucket.obsHours > 0 ? bucket.obsHours : 0;
        const label = new Date(timeValue).toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
        return {
          timeValue,
          timeLabel: label,
          ET0_mmh: bucket.et0_mm / hours,
          ETc_model_mmh: bucket.etc_model_mm / hours,
          ETc_obs_mmh: obsHours > 0 ? bucket.etc_obs_mm / obsHours : null,
          water_applied_mmh: bucket.water_applied_mm / hours,
        };
      });
  }, [metrics]);

  if (!plantId) {
    return (
      <CollapsibleTile
        id="water-model-section"
        title="Water Model"
      subtitle="Capture a sensor snapshot to view ET model diagnostics."
        className="border border-dashed border-emerald-700/50 bg-[rgba(6,30,20,0.75)] p-6 text-sm text-emerald-100/80"
      >
        <p className="text-emerald-200/70">
          The ET model visualizations will appear once a pot selection is provided.
        </p>
      </CollapsibleTile>
    );
  }

  return (
    <CollapsibleTile
      id="water-model-section"
      title="Water Model"
      subtitle={`Diagnostics for pot ${plantId}`}
      className="p-6 text-sm text-emerald-100/80"
      bodyClassName="mt-6 space-y-6"
      actions={
        <select
          value={range.hours}
          onChange={(event) => {
            const next = RANGE_OPTIONS.find((option) => option.hours === Number(event.target.value));
            if (next) {
              setRange(next);
            }
          }}
          className="rounded-lg border border-emerald-600/60 bg-[rgba(4,22,15,0.9)] px-3 py-1 text-xs text-emerald-100 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/40"
        >
          {RANGE_OPTIONS.map((option) => (
            <option key={option.hours} value={option.hours}>
              {option.label}
            </option>
          ))}
        </select>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-emerald-700/50 bg-[rgba(5,25,16,0.82)] p-4">
          <p className="text-[11px] uppercase tracking-wide text-emerald-200/60">Daily ET₀</p>
          <p className="mt-1 text-lg font-semibold text-emerald-100">
            {latestSummary ? `${latestSummary.ET0_mm.toFixed(2)} mm` : "-"}
          </p>
        </div>
        <div className="rounded-xl border border-emerald-700/50 bg-[rgba(5,25,16,0.82)] p-4">
          <p className="text-[11px] uppercase tracking-wide text-emerald-200/60">Daily ETc (model)</p>
          <p className="mt-1 text-lg font-semibold text-emerald-100">
            {latestSummary ? `${latestSummary.ETc_model_mm.toFixed(2)} mm` : "-"}
          </p>
        </div>
        <div className="rounded-xl border border-emerald-700/50 bg-[rgba(5,25,16,0.82)] p-4">
          <p className="text-[11px] uppercase tracking-wide text-emerald-200/60">Daily ETc (observed)</p>
          <p className="mt-1 text-lg font-semibold text-emerald-100">
            {latestSummary && latestSummary.observedSamples > 0 && latestSummary.ETc_obs_mm !== null
              ? `${latestSummary.ETc_obs_mm.toFixed(2)} mm`
              : "-"}
          </p>
        </div>
        <div className="rounded-xl border border-emerald-700/50 bg-[rgba(5,25,16,0.82)] p-4">
          <p className="text-[11px] uppercase tracking-wide text-emerald-200/60">Model Residual</p>
          <span className={`mt-1 inline-flex rounded-full px-3 py-1 text-xs font-semibold ${badge.className}`}>
            {badge.label}
          </span>
        </div>
      </div>

      {loading && (
        <p className="text-xs text-emerald-200/70">Loading ET model metrics...</p>
      )}
      {error && !loading && (
        <p className="text-xs text-rose-200/80">Failed to load metrics: {error}</p>
      )}
      {!loading && !error && metrics.length === 0 && (
        <p className="text-xs text-emerald-200/70">No ET model metrics available for the selected window.</p>
      )}

      {metrics.length > 0 ? (
        <div className="space-y-6">
          <div className="rounded-2xl border border-emerald-700/50 bg-[rgba(5,24,16,0.76)] p-4">
            <h3 className="text-sm font-semibold text-emerald-50">Hourly ET Balance</h3>
            <p className="mt-1 text-xs text-emerald-200/70">
              Compare atmospheric demand (ET₀), modeled demand (ET_fit), observed ET, and irrigation applied per hour.
            </p>
            <div className="mt-4 w-full" style={{ height: 320 }}>
              {hourlySeries.length ? (
                <ResponsiveContainer>
                  <ComposedChart data={hourlySeries} margin={{ top: 10, right: 24, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#134528" />
                    <XAxis
                      dataKey="timeValue"
                      type="number"
                      tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: "2-digit" })}
                      stroke="#6ee7b7"
                      tick={{ fontSize: 11, fill: "#bbf7d0" }}
                    />
                    <YAxis
                      stroke="#6ee7b7"
                      tick={{ fontSize: 11, fill: "#bbf7d0" }}
                      domain={[0, "auto"]}
                      label={{ value: "mm/h", angle: -90, position: "insideLeft", fill: "#a7f3d0" }}
                    />
                    <Tooltip
                      contentStyle={{ background: "#042414", borderColor: "#0f3d25", color: "#f0fdf4" }}
                      labelFormatter={(value) =>
                        new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" })
                      }
                      formatter={(value: number | null, name: string) => {
                        if (value === null || Number.isNaN(value)) {
                          return ["--", name];
                        }
                        return [`${value.toFixed(2)} mm/h`, name];
                      }}
                    />
                    <Legend />
                    <Bar
                      dataKey="water_applied_mmh"
                      name="Water Applied"
                      fill="#3b82f6"
                      barSize={14}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="ET0_mmh"
                      name="ET₀ (Reference)"
                      stroke="#34d399"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="ETc_model_mmh"
                      name="ET_fit (Model)"
                      stroke="#facc15"
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="ETc_obs_mmh"
                      name="ET_obs (Observed)"
                      stroke="#f87171"
                      strokeWidth={2}
                      strokeDasharray="1 6"
                      dot={false}
                      connectNulls={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-emerald-200/70">
                  {loading ? "Loading hourly ET..." : "Hourly ET data unavailable for this window."}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-emerald-700/50 bg-[rgba(5,24,16,0.76)] p-4">
            <h4 className="text-sm font-semibold text-emerald-50">Residuals (Observed - Model)</h4>
            <div className="mt-4 w-full" style={{ height: 240 }}>
              <ResponsiveContainer>
                <ComposedChart data={metrics} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#134528" />
                  <XAxis
                    dataKey="timeValue"
                    type="number"
                    tickFormatter={formatTimeTick}
                    stroke="#6ee7b7"
                    tick={{ fontSize: 11, fill: "#bbf7d0" }}
                  />
                  <YAxis
                    stroke="#6ee7b7"
                    tick={{ fontSize: 11, fill: "#bbf7d0" }}
                    domain={["auto", "auto"]}
                    label={{ value: "mm", angle: -90, position: "insideLeft", fill: "#a7f3d0" }}
                  />
                  <Tooltip
                    contentStyle={{ background: "#042414", borderColor: "#0f3d25", color: "#f0fdf4" }}
                    labelFormatter={(value) => formatTimeTick(Number(value))}
                    formatter={(value: number | null) => [formatResidual(value), "Observed - Model"]}
                  />
                  <Legend />
                  <ReferenceArea y1={0.1} y2={-0.1} fill="#0f5132" fillOpacity={0.2} />
                  <ReferenceLine y={0} stroke="#f0fdf4" strokeDasharray="4 4" />
                  <Bar
                    dataKey="residual_mm"
                    name="Residual"
                    fill="#facc15"
                    barSize={8}
                    isAnimationActive={false}
                    minPointSize={2}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-2xl border border-emerald-700/50 bg-[rgba(5,24,16,0.76)] p-4">
            <h4 className="text-sm font-semibold text-emerald-50">Coefficients</h4>
            <div className="mt-4 w-full" style={{ height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={metrics} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#134528" />
                  <XAxis
                    dataKey="timeValue"
                    type="number"
                    tickFormatter={formatTimeTick}
                    stroke="#6ee7b7"
                    tick={{ fontSize: 11, fill: "#bbf7d0" }}
                  />
                  <YAxis
                    stroke="#6ee7b7"
                    tick={{ fontSize: 11, fill: "#bbf7d0" }}
                    domain={[0, "auto"]}
                    label={{ value: "Coefficient", angle: -90, position: "insideLeft", fill: "#a7f3d0" }}
                  />
                  <Tooltip
                    contentStyle={{ background: "#042414", borderColor: "#0f3d25", color: "#f0fdf4" }}
                    labelFormatter={(value) => formatTimeTick(Number(value))}
                    formatter={(value, name) => [Number(value).toFixed(2), name]}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="Kcb_struct" name="Kcb struct" stroke="#34d399" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Kcb_eff" name="Kcb eff" stroke="#a855f7" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Ke" name="Ke" stroke="#38bdf8" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Ks" name="Ks" stroke="#f97316" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="rounded-2xl border border-emerald-700/50 bg-[rgba(5,24,16,0.76)] p-4">
            <h4 className="text-sm font-semibold text-emerald-50">Depletions</h4>
            <div className="mt-4 w-full" style={{ height: 240 }}>
              <ResponsiveContainer>
                <ComposedChart data={metrics} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#134528" />
                  <XAxis
                    dataKey="timeValue"
                    type="number"
                    tickFormatter={formatTimeTick}
                    stroke="#6ee7b7"
                    tick={{ fontSize: 11, fill: "#bbf7d0" }}
                  />
                  <YAxis
                    stroke="#6ee7b7"
                    tick={{ fontSize: 11, fill: "#bbf7d0" }}
                    domain={[0, "auto"]}
                    label={{ value: "mm", angle: -90, position: "insideLeft", fill: "#a7f3d0" }}
                  />
                  <Tooltip
                    contentStyle={{ background: "#042414", borderColor: "#0f3d25", color: "#f0fdf4" }}
                    labelFormatter={(value) => formatTimeTick(Number(value))}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="De_mm" name="Surface depletion (De)" stroke="#f97316" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Dr_mm" name="Root-zone depletion (Dr)" stroke="#22d3ee" strokeWidth={2} dot={false} />
                  <Scatter
                    name="Irrigation recommended (mm)"
                    data={irrigationEvents}
                    xAxisId={0}
                    yAxisId={0}
                    dataKey="recommend_mm"
                    shape={(props) =>
                      props.cx === undefined || props.cy === undefined ? null : (
                        <circle cx={props.cx} cy={props.cy} r={5} fill="#facc15" stroke="#713f12" strokeWidth={1} />
                      )
                    }
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      ) : null}
    </CollapsibleTile>
  );
}
