import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMockTelemetry, TelemetrySample } from "../api/hubClient";

type State = {
  data: TelemetrySample[];
  loading: boolean;
  error: string | null;
};

export function useMockTelemetry(samples = 24) {
  const [{ data, loading, error }, setState] = useState<State>({ data: [], loading: true, error: null });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const telemetry = await fetchMockTelemetry({ samples }, signal);
        setState({ data: telemetry, loading: false, error: null });
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setState({ data: [], loading: false, error: message });
      }
    },
    [samples]
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
    refresh: () => load()
  };
}
