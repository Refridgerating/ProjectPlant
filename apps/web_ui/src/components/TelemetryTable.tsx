import { TelemetrySample } from "../api/hubClient";
import { CollapsibleTile } from "./CollapsibleTile";

function formatTimestamp(value: string) {
  const date = new Date(value);
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMaybe(value: number | null | undefined, fractionDigits: number) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "--";
  }
  return value.toFixed(fractionDigits);
}

type TelemetryTableProps = {
  data: TelemetrySample[];
  tileId?: string;
  rangeLabel?: string;
};

export function TelemetryTable({
  data,
  tileId = "plant-conditions-telemetry-table",
  rangeLabel,
}: TelemetryTableProps) {
  const hasData = data.length > 0;
  const sampleCountLabel = `${data.length.toLocaleString()} observation${data.length === 1 ? "" : "s"}`;
  const subtitle = hasData
    ? `${rangeLabel ?? "Current range"} | ${sampleCountLabel}`
    : rangeLabel
    ? `No telemetry observed for ${rangeLabel.toLowerCase()}.`
    : "No telemetry observed for this window.";

  return (
    <CollapsibleTile
      id={tileId}
      title="Telemetry Samples"
      subtitle={subtitle}
      className="p-0 text-sm text-emerald-100/80"
      bodyClassName={hasData ? undefined : "p-6"}
    >
      {hasData ? (
        <div className="overflow-hidden rounded-b-2xl border-t border-emerald-800/40">
          <div className="max-h-96 overflow-auto">
            <table className="min-w-full divide-y divide-emerald-900/40 text-sm">
          <thead className="bg-[rgba(7,27,18,0.85)] text-emerald-200/70">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Time
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Soil Moisture (%)
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Temperature (deg C)
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Humidity (%)
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-medium">
                    Pressure (hPa)
                  </th>
                  <th scope="col" className="px-4 py-3 text-left font-medium">
                    Solar Radiation (W/m^2)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-950/50 bg-[rgba(4,18,12,0.78)] text-emerald-100/80">
                {data.map((entry) => (
                  <tr key={entry.timestamp}>
                    <td className="whitespace-nowrap px-4 py-2 font-medium text-emerald-50">
                      {formatTimestamp(entry.timestamp)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">{formatMaybe(entry.moisture_pct ?? null, 1)}</td>
                    <td className="whitespace-nowrap px-4 py-2">{formatMaybe(entry.temperature_c, 1)}</td>
                    <td className="whitespace-nowrap px-4 py-2">{formatMaybe(entry.humidity_pct, 1)}</td>
                    <td className="whitespace-nowrap px-4 py-2">{formatMaybe(entry.pressure_hpa, 1)}</td>
                    <td className="whitespace-nowrap px-4 py-2">{formatMaybe(entry.solar_radiation_w_m2, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="text-sm text-emerald-200/60">
          Collect telemetry or adjust the selected range to populate the table.
        </p>
      )}
    </CollapsibleTile>
  );
}
