import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { CollapsibleTile } from "./CollapsibleTile";
import { WateringRecommendation } from "../api/hubClient";

type Props = {
  recommendation: WateringRecommendation | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
};

const TILE_ID = "plant-control-watering-plan";
const HEADING = "Automated Watering Plan";

export function WateringRecommendationCard({ recommendation, loading, error, onRetry }: Props) {
  if (loading) {
    return (
      <CollapsibleTile
        id={TILE_ID}
        title={HEADING}
        subtitle="Calculating watering guidance from recent telemetry..."
        className="p-6 text-sm text-emerald-100/85"
        bodyClassName="mt-4"
        actions={<span className="inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-emerald-400/80" />}
        defaultCollapsed={false}
      >
        <p className="text-emerald-200/70">
          We will surface the recommendation as soon as the calculation completes.
        </p>
      </CollapsibleTile>
    );
  }

  if (error) {
    return (
      <CollapsibleTile
        id={TILE_ID}
        title={HEADING}
        subtitle="Unable to compute a watering plan right now."
        className="border border-rose-500/50 bg-[rgba(42,12,18,0.85)] p-6 text-sm text-rose-100"
        bodyClassName="mt-4 space-y-3 text-rose-100/80"
        actions={
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-lg border border-rose-400/70 px-3 py-1.5 text-xs font-semibold text-rose-50 transition hover:bg-rose-500/20"
          >
            <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
            Retry
          </button>
        }
      >
        <p>{error}</p>
      </CollapsibleTile>
    );
  }

  if (!recommendation) {
    return (
      <CollapsibleTile
        id={TILE_ID}
        title={HEADING}
        subtitle="Telemetry will power irrigation guidance as soon as we observe temperature and humidity samples."
        className="p-6 text-sm text-emerald-100/85"
        bodyClassName="mt-4 text-emerald-200/70"
        actions={
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-100 transition hover:border-emerald-400"
          >
            <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
        }
      >
        <p>We will surface irrigation guidance as soon as telemetry includes temperature and humidity samples.</p>
      </CollapsibleTile>
    );
  }

  const { outputs, climate, pot, pot_metrics: metrics, diagnostics } = recommendation;

  const climateSummary = `Averages ${formatValue(outputs.etc_mm_day, 2)} mm ETc, ${formatValue(
    climate.avg_temperature_c,
    1,
  )} deg C, ${formatValue(climate.avg_humidity_pct, 0)}% RH over ~${formatValue(climate.coverage_hours, 1)} h.`;

  return (
    <CollapsibleTile
      id={TILE_ID}
      title={HEADING}
      subtitle="Penman-Monteith baseline tuned for your pot profile."
      className="p-6 text-sm text-emerald-100/85"
      bodyClassName="mt-4 space-y-4"
      actions={
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-50 transition hover:border-emerald-400 hover:bg-emerald-500/25"
        >
          <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
          Refresh
        </button>
      }
    >
      <p className="text-xs text-emerald-200/70">{climateSummary}</p>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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

      <div className="grid gap-4 text-xs text-emerald-200/70 sm:grid-cols-2">
        <div>
          <h4 className="text-sm font-semibold text-emerald-50">Pot profile</h4>
          <ul className="mt-2 space-y-1">
            <li>Diameter {formatValue(pot.diameter_cm, 0)} cm / Height {formatValue(pot.height_cm, 0)} cm</li>
            <li>Available water fraction {formatValue(pot.available_water_fraction * 100, 0)}%</li>
            <li>Irrigation efficiency {formatValue(pot.irrigation_efficiency * 100, 0)}%</li>
          </ul>
        </div>
        <div>
          <h4 className="text-sm font-semibold text-emerald-50">Storage estimates</h4>
          <ul className="mt-2 space-y-1">
            <li>Surface area {formatValue(metrics.surface_area_m2, 3)} m^2</li>
            <li>Container volume {formatValue(metrics.volume_liters, 2)} L</li>
            <li>Max per event {formatValue(metrics.max_event_liters * 1000, 0)} mL ({formatValue(metrics.max_event_liters, 3)} L)</li>
          </ul>
        </div>
      </div>

      {diagnostics.notes.length ? (
        <div className="rounded-2xl border border-emerald-800/40 bg-[rgba(6,24,16,0.78)] p-3 text-xs text-emerald-200/70 shadow-inner shadow-emerald-950/40">
          <p className="font-semibold text-emerald-50">Diagnostics</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {diagnostics.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </CollapsibleTile>
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
