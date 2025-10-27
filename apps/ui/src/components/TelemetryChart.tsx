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
import { ReactNode } from "react";
import { TelemetrySample } from "../api/hubClient";
import { CollapsibleTile } from "./CollapsibleTile";

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
  tileId?: string;
  actions?: ReactNode;
};

export function TelemetryChart({
  data,
  title = "Telemetry Trends",
  subtitle = "Telemetry updates as new readings arrive.",
  tileId,
  actions,
}: TelemetryChartProps) {
  const safeId =
    tileId ??
    `telemetry-chart-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "default"}`;

  if (data.length === 0) {
    return (
      <CollapsibleTile
        id={safeId}
        title={title}
        subtitle="Waiting for sensor readings."
        actions={actions}
        className="border border-dashed border-emerald-600/45 bg-[rgba(7,27,18,0.68)] p-6 text-sm text-emerald-200/70"
        bodyClassName="mt-4"
      >
        <p>Refresh once telemetry is available to render the chart.</p>
      </CollapsibleTile>
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
      <CollapsibleTile
        id={safeId}
        title={title}
        subtitle="No timestamped observations available for the selected window."
        actions={actions}
        className="border border-dashed border-emerald-600/45 bg-[rgba(7,27,18,0.68)] p-6 text-sm text-emerald-200/70"
        bodyClassName="mt-4"
      >
        <p>Check data collection and sampling intervals, then try refreshing the dashboard.</p>
      </CollapsibleTile>
    );
  }

  const minTime = chartData[0].timeValue ?? 0;
  const maxTime = chartData[chartData.length - 1].timeValue ?? minTime;

  const hasSolarAllSky = chartData.some((sample) => sample.solar_radiation_mj_m2_h != null);
  const hasSolarClear = chartData.some((sample) => sample.solar_radiation_clear_mj_m2_h != null);
  const hasSolarDiffuse = chartData.some((sample) => sample.solar_radiation_diffuse_mj_m2_h != null);
  const hasSolarDirect = chartData.some((sample) => sample.solar_radiation_direct_mj_m2_h != null);
  const hasSolarEnergy = hasSolarAllSky || hasSolarClear || hasSolarDiffuse || hasSolarDirect;

  return (
    <CollapsibleTile
      id={safeId}
      title={title}
      subtitle={subtitle}
      actions={actions}
      className="p-6 text-sm text-emerald-100/80"
      bodyClassName="mt-5"
    >
      <div className="h-80 w-full">
        <ResponsiveContainer>
          <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#124026" />
            <XAxis
              dataKey="timeValue"
              type="number"
              domain={[minTime, maxTime]}
              tickFormatter={formatTick}
              stroke="#6ee7b7"
              tick={{ fontSize: 12, fill: "#bbf7d0" }}
            />
            <YAxis
              yAxisId="left"
              stroke="#6ee7b7"
              tick={{ fontSize: 12, fill: "#bbf7d0" }}
              domain={["auto", "auto"]}
              label={{
                value: "Temp / Humidity / Moisture / Wind",
                angle: -90,
                position: "insideLeft",
                fill: "#a7f3d0",
                offset: 10,
              }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#6ee7b7"
              tick={{ fontSize: 12, fill: "#bbf7d0" }}
              domain={[0, "auto"]}
              label={{
                value: "Pressure (hPa) / Solar (W/m²)",
                angle: 90,
                position: "insideRight",
                fill: "#a7f3d0",
                offset: 10,
              }}
            />
            {hasSolarEnergy ? (
              <YAxis
                yAxisId="energy"
                orientation="right"
                axisLine={false}
                tickLine={false}
                stroke="#f97316"
                tick={{ fontSize: 12, fill: "#fed7aa" }}
                domain={[0, "auto"]}
                label={{
                  value: "Solar (MJ/m²/h)",
                  angle: 90,
                  position: "insideRight",
                  fill: "#fdba74",
                  offset: -5,
                }}
              />
            ) : null}
            <Tooltip
              contentStyle={{ background: "#052016", borderColor: "#10402a", color: "#ecfdf5" }}
              labelFormatter={(value) => formatTick(Number(value))}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="moisture_pct"
              name="Soil Moisture (%)"
              stroke="#a855f7"
              strokeWidth={2}
              yAxisId="left"
              connectNulls
            />
            <Line type="monotone" dataKey="temperature_c" name="Temp (deg C)" stroke="#34d399" strokeWidth={2} yAxisId="left" />
            <Line type="monotone" dataKey="humidity_pct" name="Humidity (%)" stroke="#5eead4" strokeWidth={2} yAxisId="left" />
            <Line type="monotone" dataKey="pressure_hpa" name="Pressure (hPa)" stroke="#facc15" strokeWidth={2} yAxisId="right" />
            <Line
              type="monotone"
              dataKey="solar_radiation_w_m2"
              name="Solar (W/m^2)"
              stroke="#f59e0b"
              strokeWidth={2}
              yAxisId="right"
              connectNulls
              dot={false}
            />
            {hasSolarAllSky ? (
              <Line
                type="monotone"
                dataKey="solar_radiation_mj_m2_h"
                name="Solar (MJ/m^2/h)"
                stroke="#fb923c"
                strokeWidth={2}
                yAxisId="energy"
                connectNulls
                dot={false}
              />
            ) : null}
            {hasSolarClear ? (
              <Line
                type="monotone"
                dataKey="solar_radiation_clear_mj_m2_h"
                name="Solar Clear (MJ/m^2/h)"
                stroke="#fcd34d"
                strokeWidth={2}
                strokeDasharray="6 2"
                yAxisId="energy"
                connectNulls
                dot={false}
              />
            ) : null}
            {hasSolarDiffuse ? (
              <Line
                type="monotone"
                dataKey="solar_radiation_diffuse_mj_m2_h"
                name="Solar Diffuse (MJ/m^2/h)"
                stroke="#fde68a"
                strokeWidth={2}
                strokeDasharray="4 3"
                yAxisId="energy"
                connectNulls
                dot={false}
              />
            ) : null}
            {hasSolarDirect ? (
              <Line
                type="monotone"
                dataKey="solar_radiation_direct_mj_m2_h"
                name="Solar Direct (MJ/m^2/h)"
                stroke="#f97316"
                strokeWidth={2}
                strokeDasharray="2 2"
                yAxisId="energy"
                connectNulls
                dot={false}
              />
            ) : null}
            <Line
              type="monotone"
              dataKey="wind_speed_m_s"
              name="Wind (m/s)"
              stroke="#67e8f9"
              strokeWidth={2}
              strokeDasharray="5 3"
              yAxisId="left"
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </CollapsibleTile>
  );
}
