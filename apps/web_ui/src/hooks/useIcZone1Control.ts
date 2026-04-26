import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { controlIcZone1, type ControlIcZone1Options, type SensorReadPayload } from "../api/hubClient";

type IcZone1Feedback = {
  type: "info" | "success" | "error";
  message: string;
};

type IcZone1State = {
  actual: boolean | null;
  optimistic: boolean | null;
  pending: boolean;
  requestId: string | null;
  lastConfirmedAt: string | null;
};

export type IcZone1TelemetrySource = Pick<SensorReadPayload, "icZone1On" | "timestamp" | "timestampMs"> & {
  requestId?: string | null;
};

export type IcZone1CommandParams = Omit<ControlIcZone1Options, "signal"> & { potId: string };

export type IcZone1ToggleParams = Omit<IcZone1CommandParams, "on">;

export type UseIcZone1ControlResult = {
  isOn: boolean | null;
  pending: boolean;
  optimistic: boolean | null;
  requestId: string | null;
  lastConfirmedAt: string | null;
  feedback: IcZone1Feedback | null;
  clearFeedback: () => void;
  command: (params: IcZone1CommandParams) => Promise<void>;
  toggle: (params: IcZone1ToggleParams) => Promise<void>;
  syncTelemetry: (payload: IcZone1TelemetrySource | null | undefined) => void;
};

const INITIAL_STATE: IcZone1State = {
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

export function useIcZone1Control(
  initial?: { icZone1On?: boolean | null },
  activePotId?: string
): UseIcZone1ControlResult {
  const [state, setState] = useState<IcZone1State>(() => ({
    ...INITIAL_STATE,
    actual: typeof initial?.icZone1On === "boolean" ? initial.icZone1On : INITIAL_STATE.actual,
  }));
  const [feedback, setFeedback] = useState<IcZone1Feedback | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastPotIdRef = useRef<string | null>(null);

  const normalizedPotId = activePotId ? activePotId.trim().toLowerCase() : "";
  const initialActual = typeof initial?.icZone1On === "boolean" ? initial.icZone1On : INITIAL_STATE.actual;

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

  const syncTelemetry = useCallback((payload: IcZone1TelemetrySource | null | undefined) => {
    if (!payload || typeof payload.icZone1On !== "boolean") {
      return;
    }
    const nextTimestamp = formatTimestamp(payload.timestamp, payload.timestampMs);
    setState((prev) => ({
      actual: payload.icZone1On,
      optimistic: null,
      pending: false,
      requestId: payload.requestId ?? prev.requestId,
      lastConfirmedAt: nextTimestamp ?? prev.lastConfirmedAt,
    }));
  }, []);

  const command = useCallback(async ({ potId, on, durationMs, timeout }: IcZone1CommandParams) => {
    const trimmedId = potId.trim();
    if (!trimmedId) {
      setFeedback({
        type: "error",
        message: "Enter a pot id before controlling IC Zone 1.",
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
      message: `Sending IC Zone 1 ${on ? "on" : "off"} command...`,
    });

    try {
      const response = await controlIcZone1(trimmedId, {
        on,
        durationMs,
        timeout,
        signal: controller.signal,
      });
      const confirmedOn = typeof response.payload.icZone1On === "boolean" ? response.payload.icZone1On : on;
      const timestampLabel = formatTimestamp(response.payload.timestamp, response.payload.timestampMs);
      const requestId = response.requestId ?? null;

      setState({
        actual: confirmedOn,
        optimistic: null,
        pending: false,
        requestId,
        lastConfirmedAt: timestampLabel,
      });

      const parts: string[] = [`IC Zone 1 ${confirmedOn ? "on" : "off"} confirmed.`];
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
      const message = err instanceof Error ? err.message : "IC Zone 1 command failed";
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
    async ({ potId, durationMs, timeout }: IcZone1ToggleParams) => {
      if (state.pending) {
        setFeedback({
          type: "info",
          message: "IC Zone 1 command already in progress. Please wait for confirmation.",
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
