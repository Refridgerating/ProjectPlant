import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchLiveTelemetry, TelemetrySample } from "../api/hubClient";
import { RuntimeMode } from "../settings";

type UseTelemetryOptions = {
  mode: RuntimeMode;
  samples?: number;
  hours?: number;
};

type State = {
  data: TelemetrySample[];
  loading: boolean;
  error: string | null;
};

function normalizeSamples(data: TelemetrySample[]): TelemetrySample[] {
  return [...data].sort((a, b) => {
    const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return at - bt;
  });
}

function generateDemoTelemetry(samples: number, hours: number): TelemetrySample[] {
  const count = Math.max(12, samples);
  const windowHours = Math.max(1, hours);
  const intervalMs = Math.max(5 * 60 * 1000, Math.round((windowHours * 60 * 60 * 1000) / count));
  const start = Date.now() - intervalMs * (count - 1);

  return Array.from({ length: count }, (_, index) => {
    const progress = count === 1 ? 1 : index / (count - 1);
    const dayArc = Math.sin(progress * Math.PI);
    const timestamp = new Date(start + intervalMs * index).toISOString();
    const temperature = 21.5 + Math.sin(index / 2.8) * 2.8 + dayArc * 1.4;
    const humidity = 56 - Math.sin(index / 3.1) * 7.5;
    const solar = Math.max(0, 680 * dayArc);
    const moisture = 47 + Math.cos(index / 3.4) * 6.2;
    const pressure = 1011.5 + Math.sin(index / 5.2) * 3.8;
    const wind = 0.35 + (Math.cos(index / 4.7) + 1) * 0.28;

    return {
      timestamp,
      temperature_c: Number(temperature.toFixed(1)),
      humidity_pct: Number(humidity.toFixed(1)),
      pressure_hpa: Number(pressure.toFixed(1)),
      solar_radiation_w_m2: Number(solar.toFixed(1)),
      moisture_pct: Number(moisture.toFixed(1)),
      wind_speed_m_s: Number(wind.toFixed(2)),
      station: "demo-greenhouse",
      source: "demo",
    };
  });
}

export function useTelemetry({ mode, samples = 24, hours = 24 }: UseTelemetryOptions) {
  const [{ data, loading, error }, setState] = useState<State>({ data: [], loading: true, error: null });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const telemetry =
          mode === "live"
            ? await fetchLiveTelemetry({ hours, limit: samples }, signal)
            : generateDemoTelemetry(samples, hours);
        setState({ data: normalizeSamples(telemetry), loading: false, error: null });
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setState({ data: [], loading: false, error: message });
      }
    },
    [mode, samples, hours]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const latest = useMemo(() => (data.length ? data[data.length - 1] : null), [data]);

  return {
    data,
    latest,
    loading,
    error,
    refresh: () => load(),
  };
}
