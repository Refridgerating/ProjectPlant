import { useCallback, useEffect, useState } from "react";
import { fetchHubInfo, HubInfo } from "../api/hubClient";

type HubInfoState = {
  data: HubInfo | null;
  loading: boolean;
  error: string | null;
};

export function useHubInfo() {
  const [{ data, loading, error }, setState] = useState<HubInfoState>({
    data: null,
    loading: true,
    error: null
  });

  const load = useCallback(async (signal?: AbortSignal) => {
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return {
    data,
    loading,
    error,
    refresh: () => load()
  };
}
