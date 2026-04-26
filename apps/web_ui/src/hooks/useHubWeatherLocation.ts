import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWeatherLocation, type WeatherLocation, upsertWeatherLocation } from "../api/hubClient";

type HubWeatherLocationState = {
  location: WeatherLocation | null;
  loading: boolean;
  error: string | null;
  syncing: boolean;
};

export function useHubWeatherLocation(enabled: boolean) {
  const controllerRef = useRef<AbortController | null>(null);
  const [{ location, loading, error, syncing }, setState] = useState<HubWeatherLocationState>({
    location: null,
    loading: enabled,
    error: null,
    syncing: false,
  });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!enabled) {
        setState({ location: null, loading: false, error: null, syncing: false });
        return;
      }
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const nextLocation = await fetchWeatherLocation(signal);
        if (signal?.aborted) {
          return;
        }
        setState((prev) => ({
          ...prev,
          location: nextLocation,
          loading: false,
          error: null,
        }));
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to load the hub weather location.";
        setState((prev) => ({
          ...prev,
          loading: false,
          error: message,
        }));
      }
    },
    [enabled]
  );

  const refresh = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    void load(controller.signal);
  }, [load]);

  const syncLocation = useCallback(
    async (payload: {
      lat: number;
      lon: number;
      accuracyM?: number | null;
      observedAt?: string | null;
      source?: string;
    }) => {
      if (!enabled) {
        return null;
      }
      setState((prev) => ({ ...prev, syncing: true, error: null }));
      try {
        const nextLocation = await upsertWeatherLocation(payload);
        setState((prev) => ({
          ...prev,
          location: nextLocation,
          syncing: false,
          error: null,
        }));
        return nextLocation;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to sync the hub weather location.";
        setState((prev) => ({
          ...prev,
          syncing: false,
          error: message,
        }));
        throw err;
      }
    },
    [enabled]
  );

  useEffect(() => {
    refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);

  return {
    location,
    loading,
    error,
    syncing,
    refresh,
    syncLocation,
  };
}
