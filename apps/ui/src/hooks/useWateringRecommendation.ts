import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TelemetrySample,
  WateringRecommendation,
  WateringRequest,
  fetchWateringRecommendation,
} from "../api/hubClient";

type Options = {
  potDiameterCm: number;
  potHeightCm?: number;
  cropCoefficient?: number;
  plantName?: string;
  lookbackHours?: number;
  availableWaterFraction?: number;
  irrigationEfficiency?: number;
  targetRefillFraction?: number;
  assumedWindSpeed?: number;
  netRadiationFactor?: number;
};

export type WateringRecommendationState = {
  data: WateringRecommendation | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

const MAX_SAMPLES = 96;

export function useWateringRecommendation(
  samples: TelemetrySample[],
  options: Options
): WateringRecommendationState {
  const {
    potDiameterCm,
    potHeightCm,
    cropCoefficient = 0.85,
    plantName = "Indoor Pot",
    lookbackHours = 24,
    availableWaterFraction = 0.35,
    irrigationEfficiency = 0.9,
    targetRefillFraction = 0.45,
    assumedWindSpeed = 0.1,
    netRadiationFactor = 0.75,
  } = options;

  const normalizedHeight = potHeightCm ?? Math.max(potDiameterCm * 0.85, 10);

  const requestSamples = useMemo(() => {
    const trimmed = samples.length > MAX_SAMPLES ? samples.slice(samples.length - MAX_SAMPLES) : samples.slice();
    return trimmed
      .filter((sample) => Boolean(sample.timestamp))
      .map((sample) => ({
        timestamp: sample.timestamp,
        temperature_c: sample.temperature_c ?? null,
        humidity_pct: sample.humidity_pct ?? null,
        pressure_hpa: sample.pressure_hpa ?? null,
        solar_radiation_w_m2: sample.solar_radiation_w_m2 ?? null,
        wind_speed_m_s: sample.wind_speed_m_s ?? null,
      }));
  }, [samples]);

  const controllerRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<Omit<WateringRecommendationState, "refresh">>({
    data: null,
    loading: false,
    error: null,
  });
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!requestSamples.length) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    if (controllerRef.current) {
      controllerRef.current.abort();
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const payload: WateringRequest = {
      method: "penman_monteith",
      lookback_hours: lookbackHours,
      assumed_wind_speed_m_s: assumedWindSpeed,
      net_radiation_factor: netRadiationFactor,
      samples: requestSamples,
      plant: {
        name: plantName,
        crop_coefficient: cropCoefficient,
      },
      pot: {
        diameter_cm: potDiameterCm,
        height_cm: normalizedHeight,
        available_water_fraction: availableWaterFraction,
        irrigation_efficiency: irrigationEfficiency,
        target_refill_fraction: targetRefillFraction,
      },
    };

    fetchWateringRecommendation(payload, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setState({ data: result, loading: false, error: null });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : "Unable to load watering guidance";
          setState((prev) => ({ ...prev, loading: false, error: message }));
        }
      });

    return () => {
      controller.abort();
    };
  }, [
    assumedWindSpeed,
    availableWaterFraction,
    cropCoefficient,
    irrigationEfficiency,
    lookbackHours,
    netRadiationFactor,
    normalizedHeight,
    plantName,
    potDiameterCm,
    requestSamples,
    targetRefillFraction,
    nonce,
  ]);

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    refresh,
  };
}
