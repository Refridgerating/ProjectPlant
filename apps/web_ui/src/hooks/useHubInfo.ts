import { useCallback, useEffect, useState } from "react";
import { fetchHubInfo, HubInfo } from "../api/hubClient";

type HubInfoState = {
  data: HubInfo | null;
  loading: boolean;
  error: string | null;
};

export function useHubInfo(enabled = true) {
  const [{ data, loading, error }, setState] = useState<HubInfoState>({
    data: null,
    loading: enabled,
    error: null
  });

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const info = await fetchHubInfo(signal);
      setState({ data: info, loading: false, error: null });
    } catch (err) {
      if (signal?.aborted) {
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      setState({ data: null, loading: false, error: message });
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [enabled, load]);

  return {
    data,
    loading,
    error,
    refresh: () => load()
  };
}
