import { TelemetrySample } from "../api/hubClient";

function formatNumber(value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat("en-US", options).format(value);
}

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
      <section className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">
        <h2 className="text-base font-semibold text-slate-200">Latest Conditions</h2>
        <p className="mt-2">Waiting for simulated readings…</p>
      </section>
    );
  }

  return (
    <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/70 p-6 md:grid-cols-4">
      <header className="md:col-span-4">
        <h2 className="text-base font-semibold text-slate-200">Latest Conditions</h2>
        <p className="text-sm text-slate-400">{formatTimestamp(latest.timestamp)}</p>
      </header>
      <Metric label="Temperature" value={`${formatNumber(latest.temperature_c, { maximumFractionDigits: 1 })} °C`} />
      <Metric label="Humidity" value={`${formatNumber(latest.humidity_pct, { maximumFractionDigits: 1 })} %`} />
      <Metric label="Pressure" value={`${formatNumber(latest.pressure_hpa, { maximumFractionDigits: 1 })} hPa`} />
      <Metric
        label="Solar Radiation"
        value={`${formatNumber(latest.solar_radiation_w_m2, { maximumFractionDigits: 0 })} W/m²`}
      />
    </section>
  );
}

type MetricProps = {
  label: string;
  value: string;
};

function Metric({ label, value }: MetricProps) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-100">{value}</p>
    </div>
  );
}
