import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TelemetrySample } from "../api/hubClient";

function toTimestamp(value: string | undefined | null): number | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

function formatTick(time: number): string {
  const date = new Date(time);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

type TelemetryChartProps = {
  data: TelemetrySample[];
  title?: string;
  subtitle?: string;
};

export function TelemetryChart({
  data,
  title = "Telemetry Trends",
  subtitle = "Live mock data updates every refresh.",
}: TelemetryChartProps) {
  if (data.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">
        <h2 className="text-base font-semibold text-slate-200">{title}</h2>
        <p className="mt-2">Waiting for simulated readings…</p>
      </section>
    );
  }

  const chartData = data
    .map((sample) => {
      const timeValue = toTimestamp(sample.timestamp);
      return {
        ...sample,
        timeValue,
        timeLabel: sample.timestamp ?? "",
      };
    })
    .filter((sample) => sample.timeValue !== null)
    .sort((a, b) => (a.timeValue ?? 0) - (b.timeValue ?? 0));

  if (!chartData.length) {
    return (
      <section className="rounded-xl border border-dashed border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">
        <h2 className="text-base font-semibold text-slate-200">{title}</h2>
        <p className="mt-2">No timestamped observations available for the selected window.</p>
      </section>
    );
  }

  const minTime = chartData[0].timeValue ?? 0;
  const maxTime = chartData[chartData.length - 1].timeValue ?? minTime;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-200">{title}</h2>
          <p className="text-sm text-slate-400">{subtitle}</p>
        </div>
      </div>
      <div className="mt-6 h-80 w-full">
        <ResponsiveContainer>
          <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis
              dataKey="timeValue"
              type="number"
              domain={[minTime, maxTime]}
              tickFormatter={formatTick}
              stroke="#94a3b8"
              tick={{ fontSize: 12 }}
            />
            <YAxis
              yAxisId="left"
              stroke="#94a3b8"
              tick={{ fontSize: 12 }}
              domain={["auto", "auto"]}
              label={{ value: "Temp / Humidity", angle: -90, position: "insideLeft", fill: "#94a3b8", offset: 10 }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#94a3b8"
              tick={{ fontSize: 12 }}
              domain={[0, "auto"]}
              label={{ value: "Pressure / Solar", angle: 90, position: "insideRight", fill: "#94a3b8", offset: 10 }}
            />
            <Tooltip
              contentStyle={{ background: "#0f172a", borderColor: "#1e293b" }}
              labelFormatter={(value) => formatTick(Number(value))}
            />
            <Legend />
            <Line type="monotone" dataKey="temperature_c" name="Temp (°C)" stroke="#38bdf8" strokeWidth={2} yAxisId="left" />
            <Line type="monotone" dataKey="humidity_pct" name="Humidity (%)" stroke="#fbbf24" strokeWidth={2} yAxisId="left" />
            <Line type="monotone" dataKey="pressure_hpa" name="Pressure (hPa)" stroke="#a855f7" strokeWidth={2} yAxisId="right" />
            <Line
              type="monotone"
              dataKey="solar_radiation_w_m2"
              name="Solar (W/m²)"
              stroke="#f97316"
              strokeWidth={2}
              yAxisId="right"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
