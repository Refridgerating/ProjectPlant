import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TelemetrySample,
  WateringRecommendation,
  buildWateringRecommendationRequest,
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

export function useWateringRecommendation(
  samples: TelemetrySample[],
  options: Options,
  enabled = true
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

  const requestPayload = useMemo(
    () =>
      buildWateringRecommendationRequest(samples, {
        potDiameterCm,
        potHeightCm,
        cropCoefficient,
        plantName,
        lookbackHours,
        availableWaterFraction,
        irrigationEfficiency,
        targetRefillFraction,
        assumedWindSpeed,
        netRadiationFactor,
      }),
    [
      assumedWindSpeed,
      availableWaterFraction,
      cropCoefficient,
      irrigationEfficiency,
      lookbackHours,
      netRadiationFactor,
      plantName,
      potDiameterCm,
      potHeightCm,
      samples,
      targetRefillFraction,
    ]
  );

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
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    if (!requestPayload.samples.length) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    if (controllerRef.current) {
      controllerRef.current.abort();
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    fetchWateringRecommendation(requestPayload, controller.signal)
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
  }, [requestPayload, nonce, enabled]);

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    refresh,
  };
}
