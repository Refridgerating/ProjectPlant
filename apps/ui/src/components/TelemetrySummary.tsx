import { TelemetrySample } from "../api/hubClient";
import { CollapsibleTile } from "./CollapsibleTile";

function formatTimestamp(value: string) {
  const date = new Date(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

type TelemetrySummaryProps = {
  latest: TelemetrySample | null;
};

export function TelemetrySummary({ latest }: TelemetrySummaryProps) {
  if (!latest) {
    return (
      <CollapsibleTile
        id="plant-conditions-latest"
        title="Latest Conditions"
        subtitle="Waiting for sensor readings."
        className="border border-dashed border-emerald-600/45 bg-[rgba(7,29,19,0.68)] p-6 text-sm text-emerald-200/70"
        bodyClassName="mt-4"
      >
        <p>We will display the latest snapshot once telemetry starts streaming.</p>
      </CollapsibleTile>
    );
  }

  const temperatureDisplay =
    latest.temperature_c != null
      ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(latest.temperature_c)} deg C`
      : "--";
  const humidityDisplay =
    latest.humidity_pct != null
      ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(latest.humidity_pct)} %`
      : "--";
  const pressureDisplay =
    latest.pressure_hpa != null
      ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(latest.pressure_hpa)} hPa`
      : "--";
  const solarDisplay =
    latest.solar_radiation_w_m2 != null
      ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(latest.solar_radiation_w_m2)} W/m^2`
      : "--";

  return (
    <CollapsibleTile
      id="plant-conditions-latest"
      title="Latest Conditions"
      subtitle={formatTimestamp(latest.timestamp)}
      className="p-6 text-sm text-emerald-100/85"
      bodyClassName="mt-4 grid gap-4 md:grid-cols-5"
    >
      <Metric
        label="Soil Moisture"
        value={
          latest.moisture_pct != null
            ? `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(latest.moisture_pct)} %`
            : "--"
        }
      />
      <Metric label="Temperature" value={temperatureDisplay} />
      <Metric label="Humidity" value={humidityDisplay} />
      <Metric label="Pressure" value={pressureDisplay} />
      <Metric label="Solar Radiation" value={solarDisplay} />
    </CollapsibleTile>
  );
}

type MetricProps = {
  label: string;
  value: string;
};

function Metric({ label, value }: MetricProps) {
  return (
    <div className="rounded-2xl border border-emerald-800/40 bg-[rgba(6,24,16,0.75)] p-4 shadow-inner shadow-emerald-950/40">
      <p className="text-xs uppercase tracking-wide text-emerald-200/60">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-emerald-50">{value}</p>
    </div>
  );
}
