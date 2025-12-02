import { useCallback, useEffect, useRef, useState } from "react";
import { fetchHrrrPoint, fetchLocalWeather, TelemetrySample, WeatherSeries, WeatherStation } from "../api/hubClient";

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
  sources: string[];
  hrrrUsed: boolean;
  hrrrError: string | null;
  refreshingHrrr: boolean;
};

export function useLocalWeather(location: Coordinates | null, hours: number, options?: { maxSamples?: number }) {
  const maxSamples = options?.maxSamples ?? 24;
  const controllerRef = useRef<AbortController | null>(null);
  const [
    { data, latest, loading, error, coverageHours, availableWindows, station, sources, hrrrUsed, hrrrError, refreshingHrrr },
    setState,
  ] = useState<LocalWeatherState>({
    data: [],
    latest: null,
    loading: false,
    error: null,
    coverageHours: 0,
    availableWindows: [],
    station: null,
    sources: [],
    hrrrUsed: false,
    hrrrError: null,
    refreshingHrrr: false,
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
          sources: [],
          hrrrUsed: false,
          hrrrError: null,
          refreshingHrrr: false,
        });
        return;
      }
      setState((prev) => ({ ...prev, loading: true, error: null }));
      try {
        const series: WeatherSeries = await fetchLocalWeather(
          { lat: coords.lat, lon: coords.lon, hours: windowHours },
          signal
        );
        const sorted = [...series.samples].sort((a, b) => {
          const taRaw = a.timestamp ? Date.parse(a.timestamp) : Number.NaN;
          const tbRaw = b.timestamp ? Date.parse(b.timestamp) : Number.NaN;
          const ta = Number.isNaN(taRaw) ? Number.NEGATIVE_INFINITY : taRaw;
          const tb = Number.isNaN(tbRaw) ? Number.NEGATIVE_INFINITY : tbRaw;
          return ta - tb;
        });
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
          sources: series.sources ?? [],
          hrrrUsed: series.hrrrUsed ?? false,
          hrrrError: series.hrrrError ?? null,
          refreshingHrrr: false,
        });
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setState((prev) => ({ ...prev, loading: false, error: message, refreshingHrrr: false }));
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

  const refreshHrrr = useCallback(
    async (persist = false) => {
      if (!location) {
        setState((prev) => ({ ...prev, hrrrError: "Location required to refresh HRRR." }));
        return;
      }
      setState((prev) => ({ ...prev, refreshingHrrr: true, hrrrError: null }));
      try {
        await fetchHrrrPoint({ lat: location.lat, lon: location.lon, refresh: true, persist });
        await load(location, hours);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to refresh HRRR data";
        setState((prev) => ({ ...prev, hrrrError: message }));
      } finally {
        setState((prev) => ({ ...prev, refreshingHrrr: false }));
      }
    },
    [location, load, hours]
  );

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
    sources,
    hrrrUsed,
    hrrrError,
    refreshingHrrr,
    refresh,
    refreshHrrr,
  };
}
