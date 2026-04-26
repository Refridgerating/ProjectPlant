import { useCallback, useEffect, useRef, useState } from "react";
import {
  requestSensorRead,
  type RequestSensorReadOptions,
  type SensorReadPayload,
  type SensorReadResponse,
} from "../api/hubClient";

type SensorReadState = {
  data: SensorReadPayload | null;
  error: string | null;
  loading: boolean;
  requestId: string | null;
  potId: string | null;
};

type RequestParams = {
  potId: string;
  timeout?: RequestSensorReadOptions["timeout"];
};

const IDLE_STATE: SensorReadState = {
  data: null,
  error: null,
  loading: false,
  requestId: null,
  potId: null,
};

export type UseSensorReadResult = SensorReadState & {
  request: (params: RequestParams) => Promise<SensorReadResponse | null>;
  cancel: () => void;
  reset: () => void;
};

export function useSensorRead(): UseSensorReadResult {
  const [state, setState] = useState<SensorReadState>(IDLE_STATE);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  const request = useCallback(
    async ({ potId, timeout }: RequestParams): Promise<SensorReadResponse | null> => {
      const trimmed = potId.trim();
      if (!trimmed) {
        setState((prev) => ({
          ...prev,
          error: "Pot ID is required",
          loading: false,
          potId: null,
        }));
        return null;
      }

      if (abortRef.current) {
        abortRef.current.abort();
      }
      const controller = new AbortController();
      abortRef.current = controller;

      setState((prev) => ({
        ...prev,
        loading: true,
        error: null,
        potId: trimmed,
      }));

      try {
        const result = await requestSensorRead(trimmed, {
          timeout,
          signal: controller.signal,
        });
        setState({
          data: result.payload,
          error: null,
          loading: false,
          requestId: result.requestId,
          potId: trimmed,
        });
        return result;
      } catch (err) {
        if (controller.signal.aborted) {
          return null;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setState((prev) => ({
          ...prev,
          loading: false,
          error: message,
          requestId: null,
        }));
        return null;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    []
  );

  const reset = useCallback(() => {
    cancel();
    setState(IDLE_STATE);
  }, [cancel]);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  return {
    ...state,
    request,
    cancel,
    reset,
  };
}

