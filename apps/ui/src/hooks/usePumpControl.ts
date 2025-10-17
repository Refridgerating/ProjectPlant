import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { controlPump, type ControlPumpOptions, type SensorReadPayload } from "../api/hubClient";

type PumpFeedback = {
  type: "info" | "success" | "error";
  message: string;
};

type PumpState = {
  actual: boolean | null;
  optimistic: boolean | null;
  pending: boolean;
  requestId: string | null;
  lastConfirmedAt: string | null;
};

export type PumpTelemetrySource = Pick<SensorReadPayload, "valveOpen" | "timestamp" | "timestampMs"> & {
  requestId?: string | null;
};

export type PumpCommandParams = Omit<ControlPumpOptions, "signal"> & { potId: string };

export type PumpToggleParams = Omit<PumpCommandParams, "on">;

export type UsePumpControlResult = {
  isOn: boolean | null;
  pending: boolean;
  optimistic: boolean | null;
  requestId: string | null;
  lastConfirmedAt: string | null;
  feedback: PumpFeedback | null;
  clearFeedback: () => void;
  command: (params: PumpCommandParams) => Promise<void>;
  toggle: (params: PumpToggleParams) => Promise<void>;
  syncTelemetry: (payload: PumpTelemetrySource | null | undefined) => void;
};

const INITIAL_STATE: PumpState = {
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

export function usePumpControl(initial?: { valveOpen?: boolean | null }): UsePumpControlResult {
  const [state, setState] = useState<PumpState>(() => ({
    ...INITIAL_STATE,
    actual: typeof initial?.valveOpen === "boolean" ? initial.valveOpen : INITIAL_STATE.actual,
  }));
  const [feedback, setFeedback] = useState<PumpFeedback | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearFeedback = useCallback(() => setFeedback(null), []);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
      }
    };
  }, []);

  const syncTelemetry = useCallback((payload: PumpTelemetrySource | null | undefined) => {
    if (!payload || typeof payload.valveOpen !== "boolean") {
      return;
    }
    const nextTimestamp = formatTimestamp(payload.timestamp, payload.timestampMs);
    setState((prev) => ({
      actual: payload.valveOpen,
      optimistic: null,
      pending: false,
      requestId: payload.requestId ?? prev.requestId,
      lastConfirmedAt: nextTimestamp ?? prev.lastConfirmedAt,
    }));
  }, []);

  const command = useCallback(async ({ potId, on, durationMs, timeout }: PumpCommandParams) => {
    const trimmedId = potId.trim();
    if (!trimmedId) {
      setFeedback({
        type: "error",
        message: "Enter a pot id before controlling the pump.",
      });
      return;
    }

    // Abort any in-flight request to avoid overlapping confirmations.
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
      message: `Sending pump ${on ? "on" : "off"} command...`,
    });

    try {
      const response = await controlPump(trimmedId, {
        on,
        durationMs,
        timeout,
        signal: controller.signal,
      });
      const confirmedOn = typeof response.payload.valveOpen === "boolean" ? response.payload.valveOpen : on;
      const timestampLabel = formatTimestamp(response.payload.timestamp, response.payload.timestampMs);
      const requestId = response.requestId ?? null;

      setState({
        actual: confirmedOn,
        optimistic: null,
        pending: false,
        requestId,
        lastConfirmedAt: timestampLabel,
      });

      const parts: string[] = [`Pump ${confirmedOn ? "on" : "off"} confirmed.`];
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
      const message = err instanceof Error ? err.message : "Pump command failed";
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
    async ({ potId, durationMs, timeout }: PumpToggleParams) => {
      if (state.pending) {
        setFeedback({
          type: "info",
          message: "Pump command already in progress. Please wait for confirmation.",
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
