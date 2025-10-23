import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLocalWeather, TelemetrySample, WeatherSeries, WeatherStation } from "../api/hubClient";

type Coordinates = {
  lat: number;
  lon: number;
};

type LocalWeatherState = {
  data: TelemetrySample[];
  latest: TelemetrySample | null;
  loading: boolean;
  error: string | null;
  coverageHours: number;
  availableWindows: number[];
  station: WeatherStation | null;
};

export function useLocalWeather(location: Coordinates | null, hours: number, options?: { maxSamples?: number }) {
  const maxSamples = options?.maxSamples ?? 24;
  const controllerRef = useRef<AbortController | null>(null);
  const [{ data, latest, loading, error, coverageHours, availableWindows, station }, setState] =
    useState<LocalWeatherState>({
      data: [],
      latest: null,
      loading: false,
      error: null,
      coverageHours: 0,
      availableWindows: [],
      station: null,
    });

  const load = useCallback(
    async (coords: Coordinates | null, windowHours: number, signal?: AbortSignal) => {
      if (!coords) {
        setState({
          data: [],
          latest: null,
          loading: false,
          error: null,
          coverageHours: 0,
          availableWindows: [],
          station: null,
        });
        return;
      }
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const series: WeatherSeries = await fetchLocalWeather(
          { lat: coords.lat, lon: coords.lon, hours: windowHours },
          signal
        );
        const sorted = [...series.samples].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
        const trimmed = sorted.slice(-maxSamples);
        const latestSample = trimmed[trimmed.length - 1] ?? null;
        setState({
          data: trimmed,
          latest: latestSample,
          loading: false,
          error: null,
          coverageHours: series.coverageHours,
          availableWindows: series.availableWindows,
          station: series.station ?? null,
        });
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setState((prev) => ({ ...prev, loading: false, error: message }));
      }
    },
    [maxSamples]
  );

  const refresh = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    void load(location, hours, controller.signal);
  }, [load, location, hours]);

  useEffect(() => {
    refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);

  return {
    data,
    latest,
    loading,
    error,
    coverageHours,
    availableWindows,
    station,
    refresh,
  };
}
