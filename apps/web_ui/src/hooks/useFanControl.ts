import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { controlFan, type ControlFanOptions, type SensorReadPayload } from "../api/hubClient";

type FanFeedback = {
  type: "info" | "success" | "error";
  message: string;
};

type FanState = {
  actual: boolean | null;
  optimistic: boolean | null;
  pending: boolean;
  requestId: string | null;
  lastConfirmedAt: string | null;
};

export type FanTelemetrySource = Pick<SensorReadPayload, "fanOn" | "timestamp" | "timestampMs"> & {
  requestId?: string | null;
};

export type FanCommandParams = Omit<ControlFanOptions, "signal"> & { potId: string };

export type FanToggleParams = Omit<FanCommandParams, "on">;

export type UseFanControlResult = {
  isOn: boolean | null;
  pending: boolean;
  optimistic: boolean | null;
  requestId: string | null;
  lastConfirmedAt: string | null;
  feedback: FanFeedback | null;
  clearFeedback: () => void;
  command: (params: FanCommandParams) => Promise<void>;
  toggle: (params: FanToggleParams) => Promise<void>;
  syncTelemetry: (payload: FanTelemetrySource | null | undefined) => void;
};

const INITIAL_STATE: FanState = {
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

export function useFanControl(
  initial?: { fanOn?: boolean | null },
  activePotId?: string
): UseFanControlResult {
  const [state, setState] = useState<FanState>(() => ({
    ...INITIAL_STATE,
    actual: typeof initial?.fanOn === "boolean" ? initial.fanOn : INITIAL_STATE.actual,
  }));
  const [feedback, setFeedback] = useState<FanFeedback | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastPotIdRef = useRef<string | null>(null);

  const normalizedPotId = activePotId ? activePotId.trim().toLowerCase() : "";
  const initialActual = typeof initial?.fanOn === "boolean" ? initial.fanOn : INITIAL_STATE.actual;

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

  const syncTelemetry = useCallback((payload: FanTelemetrySource | null | undefined) => {
    if (!payload || typeof payload.fanOn !== "boolean") {
      return;
    }
    const nextTimestamp = formatTimestamp(payload.timestamp, payload.timestampMs);
    setState((prev) => ({
      actual: payload.fanOn,
      optimistic: null,
      pending: false,
      requestId: payload.requestId ?? prev.requestId,
      lastConfirmedAt: nextTimestamp ?? prev.lastConfirmedAt,
    }));
  }, []);

  const command = useCallback(async ({ potId, on, durationMs, timeout }: FanCommandParams) => {
    const trimmedId = potId.trim();
    if (!trimmedId) {
      setFeedback({
        type: "error",
        message: "Enter a pot id before controlling the fan.",
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
      message: `Sending fan ${on ? "on" : "off"} command...`,
    });

    try {
      const response = await controlFan(trimmedId, {
        on,
        durationMs,
        timeout,
        signal: controller.signal,
      });
      const confirmed = typeof response.payload.fanOn === "boolean" ? response.payload.fanOn : on;
      const timestampLabel = formatTimestamp(response.payload.timestamp, response.payload.timestampMs);
      const requestId = response.requestId ?? null;

      setState({
        actual: confirmed,
        optimistic: null,
        pending: false,
        requestId,
        lastConfirmedAt: timestampLabel,
      });

      const parts: string[] = [`Fan ${confirmed ? "on" : "off"} confirmed.`];
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
      const message = err instanceof Error ? err.message : "Fan command failed";
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
    async ({ potId, durationMs, timeout }: FanToggleParams) => {
      if (state.pending) {
        setFeedback({
          type: "info",
          message: "Fan command already in progress. Please wait for confirmation.",
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
