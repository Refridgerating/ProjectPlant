import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLocalWeather, TelemetrySample, WeatherSeries, WeatherStation } from "../api/hubClient";

type Coordinates = {
  lat: number;
  lon: number;
};

type LocalWeatherState = {
  data: TelemetrySample[];
  allSamples: TelemetrySample[];
  latest: TelemetrySample | null;
  loading: boolean;
  error: string | null;
  coverageHours: number;
  availableWindows: number[];
  station: WeatherStation | null;
  sources: string[];
  hrrrUsed: boolean;
  hrrrError: string | null;
};

const PREFETCH_HOURS = 48;

function normalizedSamples(samples: TelemetrySample[]): TelemetrySample[] {
  if (!samples.length) {
    return [];
  }
  return [...samples].sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : Number.NEGATIVE_INFINITY;
    const tb = b.timestamp ? Date.parse(b.timestamp) : Number.NEGATIVE_INFINITY;
    return ta - tb;
  });
}

function filterSamples(samples: TelemetrySample[], hours: number, maxSamples: number): TelemetrySample[] {
  const sorted = normalizedSamples(samples);
  if (!hours || hours <= 0) {
    return sorted.length ? [sorted[sorted.length - 1]] : [];
  }
  const cutoff = Date.now() - hours * 3600 * 1000;
  const filtered = sorted.filter((sample) => {
    if (!sample.timestamp) {
      return false;
    }
    const ts = Date.parse(sample.timestamp);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  return filtered.slice(-maxSamples);
}

function calculateCoverage(samples: TelemetrySample[]): number {
  if (samples.length < 2) {
    return 0;
  }
  const timestamps = normalizedSamples(samples)
    .map((sample) => (sample.timestamp ? Date.parse(sample.timestamp) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length < 2) {
    return 0;
  }
  const delta = timestamps[timestamps.length - 1] - timestamps[0];
  return Math.max(0, Math.round((delta / 3600000) * 100) / 100);
}

export function useLocalWeather(location: Coordinates | null, hours: number, options?: { maxSamples?: number }) {
  const maxSamples = options?.maxSamples ?? 24;
  const controllerRef = useRef<AbortController | null>(null);
  const prefetchControllerRef = useRef<AbortController | null>(null);
  const [
    {
      data,
      allSamples,
      latest,
      loading,
      error,
      coverageHours,
      availableWindows,
      station,
      sources,
      hrrrUsed,
      hrrrError,
    },
    setState,
  ] = useState<LocalWeatherState>({
    data: [],
    allSamples: [],
    latest: null,
    loading: false,
    error: null,
    coverageHours: 0,
    availableWindows: [],
    station: null,
    sources: [],
    hrrrUsed: false,
    hrrrError: null,
  });

  const load = useCallback(
    async (
      coords: Coordinates | null,
      fetchHours: number,
      filterHours: number,
      options: { signal?: AbortSignal; indicateLoading?: boolean } = {}
    ) => {
      const { signal, indicateLoading = true } = options;
      if (!coords) {
        setState({
          data: [],
          allSamples: [],
          latest: null,
          loading: false,
          error: null,
          coverageHours: 0,
          availableWindows: [],
          station: null,
          sources: [],
          hrrrUsed: false,
          hrrrError: null,
        });
        return;
      }
      if (indicateLoading) {
        setState((prev) => ({ ...prev, loading: true, error: null }));
      }
      try {
        const series: WeatherSeries = await fetchLocalWeather(
          { lat: coords.lat, lon: coords.lon, hours: fetchHours },
          signal
        );
        const samples = series.samples ?? [];
        const filtered = filterSamples(samples, filterHours, maxSamples);
        const latestSample = filtered.length ? filtered[filtered.length - 1] ?? null : null;
        setState((prev) => ({
          ...prev,
          data: filtered,
          allSamples: samples,
          latest: latestSample,
          loading: indicateLoading ? false : prev.loading,
          error: null,
          coverageHours: series.coverageHours ?? calculateCoverage(samples),
          availableWindows: series.availableWindows ?? [],
          station: series.station ?? null,
          sources: series.sources ?? [],
          hrrrUsed: series.hrrrUsed ?? false,
          hrrrError: series.hrrrError ?? null,
        }));
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setState((prev) => ({
          ...prev,
          loading: indicateLoading ? false : prev.loading,
          error: message,
        }));
      }
    },
    [maxSamples]
  );

  const refresh = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
    }
    if (prefetchControllerRef.current) {
      prefetchControllerRef.current.abort();
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    const primaryFetch = load(location, hours, hours, { signal: controller.signal, indicateLoading: true });
    primaryFetch.then(() => {
      if (!location) {
        return;
      }
      const prefetchController = new AbortController();
      prefetchControllerRef.current = prefetchController;
      void load(location, Math.max(PREFETCH_HOURS, hours), hours, {
        signal: prefetchController.signal,
        indicateLoading: false,
      });
    });
  }, [load, location, hours]);

  useEffect(() => {
    refresh();
    return () => {
      controllerRef.current?.abort();
      prefetchControllerRef.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    setState((prev) => {
      if (!prev.allSamples.length) {
        return prev;
      }
      const filtered = filterSamples(prev.allSamples, hours, maxSamples);
      return {
        ...prev,
        data: filtered,
        latest: filtered.length ? filtered[filtered.length - 1] ?? null : null,
      };
    });
  }, [hours, maxSamples]);

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
    refresh,
  };
}

