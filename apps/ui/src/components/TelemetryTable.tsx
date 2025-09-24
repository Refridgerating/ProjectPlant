import { TelemetrySample } from "../api/hubClient";

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

type TelemetryTableProps = {
  data: TelemetrySample[];
};

export function TelemetryTable({ data }: TelemetryTableProps) {
  if (data.length === 0) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800">
      <div className="max-h-96 overflow-auto">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-900/80 text-slate-400">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Time
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Temperature (°C)
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Humidity (%)
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Pressure (hPa)
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium">
                Solar Radiation (W/m²)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-900 bg-slate-950/40 text-slate-300">
            {data.map((entry) => (
              <tr key={entry.timestamp}>
                <td className="whitespace-nowrap px-4 py-2 font-medium text-slate-200">{formatTimestamp(entry.timestamp)}</td>
                <td className="whitespace-nowrap px-4 py-2">{entry.temperature_c.toFixed(1)}</td>
                <td className="whitespace-nowrap px-4 py-2">{entry.humidity_pct.toFixed(1)}</td>
                <td className="whitespace-nowrap px-4 py-2">{entry.pressure_hpa.toFixed(1)}</td>
                <td className="whitespace-nowrap px-4 py-2">{entry.solar_radiation_w_m2.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
