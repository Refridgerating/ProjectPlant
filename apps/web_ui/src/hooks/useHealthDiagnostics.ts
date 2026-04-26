import { useCallback, useEffect, useState } from "react";
import {
  AlertEvent,
  HealthSummary,
  MqttHealth,
  StorageHealth,
  WeatherCacheHealth,
  fetchHealthEvents,
  fetchHealthSummary,
  fetchMqttHealth,
  fetchStorageHealth,
  fetchWeatherCacheHealth
} from "../api/hubClient";

type HealthDiagnosticsState = {
  summary: HealthSummary | null;
  mqtt: MqttHealth | null;
  weather: WeatherCacheHealth | null;
  storage: StorageHealth | null;
  events: AlertEvent[];
  eventsCount: number;
  loading: boolean;
  error: string | null;
};

export function useHealthDiagnostics(eventLimit = 50, enabled = true) {
  const [state, setState] = useState<HealthDiagnosticsState>({
    summary: null,
    mqtt: null,
    weather: null,
    storage: null,
    events: [],
    eventsCount: 0,
    loading: enabled,
    error: null
  });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!enabled) {
        setState({
          summary: null,
          mqtt: null,
          weather: null,
          storage: null,
          events: [],
          eventsCount: 0,
          loading: false,
          error: null,
        });
        return;
      }
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const [summary, mqtt, weather, storage, eventsResponse] = await Promise.all([
          fetchHealthSummary(signal),
          fetchMqttHealth(signal),
          fetchWeatherCacheHealth(signal),
          fetchStorageHealth(signal),
          fetchHealthEvents({ limit: eventLimit }, signal)
        ]);
        if (signal?.aborted) {
          return;
        }
        setState({
          summary,
          mqtt,
          weather,
          storage,
          events: eventsResponse.events,
          eventsCount: eventsResponse.count,
          loading: false,
          error: null
        });
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to load health diagnostics.";
        setState((prev) => ({ ...prev, loading: false, error: message }));
      }
    },
    [enabled, eventLimit]
  );

  useEffect(() => {
    if (!enabled) {
      setState({
        summary: null,
        mqtt: null,
        weather: null,
        storage: null,
        events: [],
        eventsCount: 0,
        loading: false,
        error: null,
      });
      return;
    }
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [enabled, load]);

  return {
    summary: state.summary,
    mqtt: state.mqtt,
    weather: state.weather,
    storage: state.storage,
    events: state.events,
    eventsCount: state.eventsCount,
    loading: state.loading,
    error: state.error,
    refresh: () => load()
  };
}
