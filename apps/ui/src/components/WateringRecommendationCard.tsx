import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { WateringRecommendation } from "../api/hubClient";

type Props = {
  recommendation: WateringRecommendation | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
};

export function WateringRecommendationCard({ recommendation, loading, error, onRetry }: Props) {
  const heading = "Automated Watering Plan";

  if (loading) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-200">{heading}</h3>
          <span className="inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-brand-400" />
        </div>
        <p className="mt-3 text-slate-400">Calculating watering guidance from recent telemetry...</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-6 text-sm text-rose-200">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{heading}</h3>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-lg border border-rose-400/70 px-3 py-1.5 text-xs font-semibold text-rose-100 hover:bg-rose-500/20"
          >
            <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
            Retry
          </button>
        </div>
        <p className="mt-3 text-rose-100/80">{error}</p>
      </section>
    );
  }

  if (!recommendation) {
    return (
      <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-200">{heading}</h3>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-slate-600"
          >
            <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
        </div>
        <p className="mt-3 text-slate-400">
          We will surface irrigation guidance as soon as telemetry includes temperature and humidity samples.
        </p>
      </section>
    );
  }

  const { outputs, climate, pot, pot_metrics: metrics, diagnostics } = recommendation;

  const climateSummary = `Averages ${formatValue(outputs.etc_mm_day, 2)} mm ETc, ${formatValue(
    climate.avg_temperature_c,
    1,
  )} deg C, ${formatValue(climate.avg_humidity_pct, 0)}% RH over ~${formatValue(climate.coverage_hours, 1)} h.`;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-200">{heading}</h3>
          <p className="mt-1 text-xs text-slate-400">Penman-Monteith baseline tuned for your pot profile.</p>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-lg border border-brand-500/60 bg-brand-500/20 px-3 py-1.5 text-xs font-semibold text-brand-100 hover:bg-brand-500/30"
        >
          <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
          Refresh
        </button>
      </div>

      <p className="mt-4 text-xs text-slate-400">{climateSummary}</p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Metric
          label="ET0 (mm/day)"
          value={outputs.et0_mm_day}
          decimals={2}
          description="Reference evapotranspiration based on a well-watered grass surface."
        />
        <Metric
          label="ETc (mm/day)"
          value={outputs.etc_mm_day}
          decimals={2}
          description="Crop-adjusted evapotranspiration for your plant profile."
        />
        <Metric
          label="Target water (L/day)"
          value={outputs.daily_water_liters}
          decimals={3}
          description="Estimated water lost per day before irrigation efficiency adjustments."
        />
        <Metric
          label="Adjusted for efficiency (L/day)"
          value={outputs.adjusted_daily_liters}
          decimals={3}
          description="Daily water target accounting for the configured system efficiency."
        />
        <Metric
          label="Events per day"
          value={outputs.recommended_events_per_day}
          decimals={2}
          description="Suggested number of irrigation cycles to distribute the daily volume."
        />
        <Metric
          label="Per irrigation (mL)"
          value={outputs.recommended_ml_per_event}
          decimals={0}
          description="Volume to apply each cycle so the pot refills without overflow."
        />
      </div>

      <div className="mt-5 grid gap-4 text-xs text-slate-400 sm:grid-cols-2">
        <div>
          <h4 className="text-sm font-semibold text-slate-200">Pot profile</h4>
          <ul className="mt-2 space-y-1">
            <li>Diameter {formatValue(pot.diameter_cm, 0)} cm / Height {formatValue(pot.height_cm, 0)} cm</li>
            <li>Available water fraction {formatValue(pot.available_water_fraction * 100, 0)}%</li>
            <li>Irrigation efficiency {formatValue(pot.irrigation_efficiency * 100, 0)}%</li>
          </ul>
        </div>
        <div>
          <h4 className="text-sm font-semibold text-slate-200">Storage estimates</h4>
          <ul className="mt-2 space-y-1">
            <li>Surface area {formatValue(metrics.surface_area_m2, 3)} m^2</li>
            <li>Container volume {formatValue(metrics.volume_liters, 2)} L</li>
            <li>Max per event {formatValue(metrics.max_event_liters * 1000, 0)} mL ({formatValue(metrics.max_event_liters, 3)} L)</li>
          </ul>
        </div>
      </div>

      {diagnostics.notes.length ? (
        <div className="mt-5 rounded-lg border border-slate-800 bg-slate-900/70 p-3 text-xs text-slate-400">
          <p className="font-semibold text-slate-200">Diagnostics</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {diagnostics.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function formatValue(value: number, decimals: number) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(decimals);
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
      className="group relative rounded-lg border border-slate-800 bg-slate-900/70 p-3 transition-colors focus-within:border-brand-500/60 focus-within:outline-none focus-within:ring-2 focus-within:ring-brand-500/40"
      tabIndex={description ? 0 : undefined}
      title={description}
    >
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-100">{content}</p>
      {description ? (
        <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-3 w-60 -translate-x-1/2 rounded-lg border border-slate-800 bg-slate-950/90 px-3 py-2 text-xs text-slate-200 opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          {description}
        </div>
      ) : null}
    </div>
  );
}
