import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHrrrPoint, HrrrSnapshot } from "../api/hubClient";

type Coordinates = {
  lat: number;
  lon: number;
};

type HrrrState = {
  data: HrrrSnapshot | null;
  loading: boolean;
  error: string | null;
  lastUpdated: string | null;
  available: boolean;
};

type UseHrrrOptions = {
  autoRefreshMs?: number;
};

type ErrorWithStatus = Error & { status?: number };

const DEFAULT_REFRESH_MS = 15 * 60 * 1000;

export function useHrrrSnapshot(location: Coordinates | null, options?: UseHrrrOptions) {
  const autoRefreshMs = options?.autoRefreshMs ?? DEFAULT_REFRESH_MS;
  const controllerRef = useRef<AbortController | null>(null);
  const [{ data, loading, error, lastUpdated, available }, setState] = useState<HrrrState>({
    data: null,
    loading: false,
    error: null,
    lastUpdated: null,
    available: true,
  });

  const cleanupController = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
  }, []);

  const resetState = useCallback(() => {
    setState({ data: null, loading: false, error: null, lastUpdated: null, available: true });
  }, []);

  const refresh = useCallback(
    (force = false) => {
      if (!location) {
        cleanupController();
        resetState();
        return;
      }

      const controller = new AbortController();
      cleanupController();
      controllerRef.current = controller;
      const { lat, lon } = location;

      setState((prev) => ({ ...prev, loading: true, error: null }));

      fetchHrrrPoint({ lat, lon, refresh: force, persist: force }, controller.signal)
        .then((snapshot) => {
          setState({
            data: snapshot,
            loading: false,
            error: null,
            lastUpdated: snapshot.run?.valid_time ?? new Date().toISOString(),
            available: true,
          });
        })
        .catch((err) => {
          if (controller.signal.aborted) {
            return;
          }
          const status =
            err && typeof err === "object" && typeof (err as ErrorWithStatus).status === "number"
              ? (err as ErrorWithStatus).status ?? null
              : null;
          const message = err instanceof Error ? err.message : "Failed to load HRRR snapshot";
          setState((prev) => ({
            data: status === 404 ? null : prev.data,
            loading: false,
            error: message,
            lastUpdated: prev.lastUpdated,
            available: status === 404 ? false : prev.available,
          }));
        })
        .finally(() => {
          if (controllerRef.current === controller) {
            controllerRef.current = null;
          }
        });
    },
    [cleanupController, location, resetState]
  );

  useEffect(() => {
    refresh(false);
    return () => cleanupController();
  }, [refresh, cleanupController]);

  useEffect(() => {
    if (!location || autoRefreshMs <= 0) {
      return undefined;
    }
    const interval = window.setInterval(() => {
      refresh(false);
    }, autoRefreshMs);
    return () => window.clearInterval(interval);
  }, [location, autoRefreshMs, refresh]);

  return {
    data,
    loading,
    error,
    lastUpdated,
    available,
    refresh,
  } as const;
}
