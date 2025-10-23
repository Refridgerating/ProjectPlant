import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchLiveTelemetry, fetchMockTelemetry, TelemetrySample } from "../api/hubClient";
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

export function useTelemetry({ mode, samples = 24, hours = 24 }: UseTelemetryOptions) {
  const [{ data, loading, error }, setState] = useState<State>({ data: [], loading: true, error: null });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const telemetry =
          mode === "live"
            ? await fetchLiveTelemetry({ hours, limit: samples }, signal)
            : await fetchMockTelemetry({ samples }, signal);
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
