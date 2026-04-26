import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { controlLight, type ControlLightOptions, type SensorReadPayload } from "../api/hubClient";

type LightFeedback = {
  type: "info" | "success" | "error";
  message: string;
};

type LightState = {
  actual: boolean | null;
  optimistic: boolean | null;
  pending: boolean;
  requestId: string | null;
  lastConfirmedAt: string | null;
};

export type LightTelemetrySource = Pick<SensorReadPayload, "lightOn" | "timestamp" | "timestampMs"> & {
  requestId?: string | null;
};

export type LightCommandParams = Omit<ControlLightOptions, "signal"> & { potId: string };

export type LightToggleParams = Omit<LightCommandParams, "on">;

export type UseLightControlResult = {
  isOn: boolean | null;
  pending: boolean;
  optimistic: boolean | null;
  requestId: string | null;
  lastConfirmedAt: string | null;
  feedback: LightFeedback | null;
  clearFeedback: () => void;
  command: (params: LightCommandParams) => Promise<void>;
  toggle: (params: LightToggleParams) => Promise<void>;
  syncTelemetry: (payload: LightTelemetrySource | null | undefined) => void;
};

const INITIAL_STATE: LightState = {
  actual: null,
  optimistic: null,
  pending: false,
  requestId: null,
  lastConfirmedAt: null,
};

function formatTimestamp(timestamp?: string | null, timestampMs?: number | null): string | null {
  if (typeof timestamp === "string" && timestamp.trim()) {
    const parsed = new Date(timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString();
    }
  }
  if (timestampMs !== null && timestampMs !== undefined) {
    const parsed = new Date(timestampMs);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString();
    }
  }
  return null;
}

export function useLightControl(
  initial?: { lightOn?: boolean | null },
  activePotId?: string
): UseLightControlResult {
  const [state, setState] = useState<LightState>(() => ({
    ...INITIAL_STATE,
    actual: typeof initial?.lightOn === "boolean" ? initial.lightOn : INITIAL_STATE.actual,
  }));
  const [feedback, setFeedback] = useState<LightFeedback | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastPotIdRef = useRef<string | null>(null);

  const normalizedPotId = activePotId ? activePotId.trim().toLowerCase() : "";
  const initialActual = typeof initial?.lightOn === "boolean" ? initial.lightOn : INITIAL_STATE.actual;

  const clearFeedback = useCallback(() => setFeedback(null), []);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    const nextPotId = normalizedPotId || null;
    if (lastPotIdRef.current === nextPotId) {
      return;
    }
    lastPotIdRef.current = nextPotId;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setState({
      ...INITIAL_STATE,
      actual: initialActual,
    });
    setFeedback(null);
  }, [normalizedPotId, initialActual]);

  const syncTelemetry = useCallback((payload: LightTelemetrySource | null | undefined) => {
    if (!payload || typeof payload.lightOn !== "boolean") {
      return;
    }
    const nextTimestamp = formatTimestamp(payload.timestamp, payload.timestampMs);
    setState((prev) => ({
      actual: payload.lightOn,
      optimistic: null,
      pending: false,
      requestId: payload.requestId ?? prev.requestId,
      lastConfirmedAt: nextTimestamp ?? prev.lastConfirmedAt,
    }));
  }, []);

  const command = useCallback(async ({ potId, on, durationMs, timeout }: LightCommandParams) => {
    const trimmedId = potId.trim();
    if (!trimmedId) {
      setFeedback({
        type: "error",
        message: "Enter a pot id before controlling the grow light.",
      });
      return;
    }

    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setState((prev) => ({
      ...prev,
      pending: true,
      optimistic: on,
    }));

    setFeedback({
      type: "info",
      message: `Sending grow light ${on ? "on" : "off"} command...`,
    });

    try {
      const response = await controlLight(trimmedId, {
        on,
        durationMs,
        timeout,
        signal: controller.signal,
      });
      const confirmed = typeof response.payload.lightOn === "boolean" ? response.payload.lightOn : on;
      const timestampLabel = formatTimestamp(response.payload.timestamp, response.payload.timestampMs);
      const requestId = response.requestId ?? null;

      setState({
        actual: confirmed,
        optimistic: null,
        pending: false,
        requestId,
        lastConfirmedAt: timestampLabel,
      });

      const parts: string[] = [`Grow light ${confirmed ? "on" : "off"} confirmed.`];
      if (timestampLabel) {
        parts.push(`Observed ${timestampLabel}.`);
      }
      if (requestId) {
        parts.push(`Request ${requestId}.`);
      }
      setFeedback({
        type: "success",
        message: parts.join(" "),
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      const message = err instanceof Error ? err.message : "Grow light command failed";
      setState((prev) => ({
        ...prev,
        pending: false,
        optimistic: null,
      }));
      setFeedback({
        type: "error",
        message,
      });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, []);

  const toggle = useCallback(
    async ({ potId, durationMs, timeout }: LightToggleParams) => {
      if (state.pending) {
        setFeedback({
          type: "info",
          message: "Grow light command already in progress. Please wait for confirmation.",
        });
        return;
      }
      const current = state.optimistic ?? state.actual ?? false;
      await command({ potId, on: !current, durationMs, timeout });
    },
    [command, state.actual, state.optimistic, state.pending]
  );

  const displayState = useMemo<boolean | null>(() => {
    if (state.optimistic !== null) {
      return state.optimistic;
    }
    return state.actual;
  }, [state.actual, state.optimistic]);

  return {
    isOn: displayState,
    pending: state.pending,
    optimistic: state.optimistic,
    requestId: state.requestId,
    lastConfirmedAt: state.lastConfirmedAt,
    feedback,
    clearFeedback,
    command,
    toggle,
    syncTelemetry,
  };
}
