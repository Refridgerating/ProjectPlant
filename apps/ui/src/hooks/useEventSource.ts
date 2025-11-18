import { useEffect } from "react";

import { fetchEventToken, type AuthTokenResponse } from "../api/hubClient";
import { getApiBaseUrlSync } from "../settings";
import {
  useEventStore,
  selectConnectionState,
  selectLastEventAt,
  type InitialSnapshot,
  type TelemetryEvent,
  type PumpStatusEvent,
  type JobEvent,
  type AlertEvent,
} from "../state/eventStore";

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 30000;

let subscribers = 0;
let connection: EventSource | null = null;
let connecting = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let detachListeners: (() => void) | null = null;

const store = useEventStore.getState;

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(reason: string) {
  clearReconnectTimer();
  if (subscribers === 0) {
    connecting = false;
    store().setConnectionState({ connected: false, connecting: false, error: reason, reconnectAttempts: 0 });
    return;
  }
  reconnectAttempts += 1;
  const delay = Math.min(RETRY_BASE_MS * 2 ** (reconnectAttempts - 1), RETRY_MAX_MS);
  store().setConnectionState({
    connected: false,
    connecting: false,
    error: reason,
    reconnectAttempts,
  });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

function closeConnection() {
  clearReconnectTimer();
  if (detachListeners) {
    detachListeners();
    detachListeners = null;
  }
  if (connection) {
    connection.close();
    connection = null;
  }
  connecting = false;
}

function attachListeners(source: EventSource) {
  const handleOpen = () => {
    connecting = false;
    reconnectAttempts = 0;
    store().setConnectionState({
      connected: true,
      connecting: false,
      error: null,
      reconnectAttempts: 0,
    });
  };

  const handleError = () => {
    closeConnection();
    scheduleReconnect("Event stream error");
  };

  const handleInit = (event: MessageEvent<string>) => {
    const payload = safeParse<InitialSnapshot>(event.data);
    if (payload) {
      store().setInitialSnapshot(payload);
    }
  };

  const handleTelemetry = (event: MessageEvent<string>) => {
    const payload = safeParse<TelemetryEvent>(event.data);
    if (payload) {
      store().upsertTelemetry(payload);
    }
  };

  const handleStatus = (event: MessageEvent<string>) => {
    const payload = safeParse<PumpStatusEvent>(event.data);
    if (payload) {
      store().upsertPumpStatus(payload);
    }
  };

  const handleJob = (event: MessageEvent<string>) => {
    const payload = safeParse<JobEvent>(event.data);
    if (payload) {
      store().upsertJob(payload);
    }
  };

  const handleAlert = (event: MessageEvent<string>) => {
    const payload = safeParse<AlertEvent>(event.data);
    if (payload) {
      store().pushAlert(payload);
    }
  };

  source.addEventListener("open", handleOpen);
  source.addEventListener("error", handleError);
  source.addEventListener("init", handleInit as EventListener);
  source.addEventListener("telemetry", handleTelemetry as EventListener);
  source.addEventListener("status", handleStatus as EventListener);
  source.addEventListener("jobs", handleJob as EventListener);
  source.addEventListener("alerts", handleAlert as EventListener);

  detachListeners = () => {
    source.removeEventListener("open", handleOpen);
    source.removeEventListener("error", handleError);
    source.removeEventListener("init", handleInit as EventListener);
    source.removeEventListener("telemetry", handleTelemetry as EventListener);
    source.removeEventListener("status", handleStatus as EventListener);
    source.removeEventListener("jobs", handleJob as EventListener);
    source.removeEventListener("alerts", handleAlert as EventListener);
  };
}

async function connect(): Promise<void> {
  if (connecting || connection || subscribers === 0) {
    return;
  }
  connecting = true;
  store().setConnectionState({ connecting: true, error: null });
  try {
    const token = await fetchTokenWithRetry();
    if (!token || subscribers === 0) {
      connecting = false;
      return;
    }
    const base = getApiBaseUrlSync();
    const url = `${base}/events/stream?token=${encodeURIComponent(token.access_token)}`;
    const source = new EventSource(url, { withCredentials: true });
    connection = source;
    attachListeners(source);
  } catch (err) {
    connecting = false;
    scheduleReconnect(err instanceof Error ? err.message : "Failed to connect to event stream");
  }
}

async function fetchTokenWithRetry(): Promise<AuthTokenResponse | null> {
  try {
    return await fetchEventToken();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token request failed";
    throw new Error(message);
  }
}

function safeParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function useEventSource(enabled = true) {
  const connectionState = useEventStore(selectConnectionState);
  const lastEventAt = useEventStore(selectLastEventAt);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    subscribers += 1;
    if (!connection && !connecting) {
      reconnectAttempts = 0;
      void connect();
    }
    return () => {
      subscribers = Math.max(0, subscribers - 1);
      if (subscribers === 0) {
        closeConnection();
        store().setConnectionState({
          connected: false,
          connecting: false,
          error: null,
          reconnectAttempts: 0,
        });
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (subscribers > 0 && !connection && !connecting && !reconnectTimer) {
      void connect();
    }
  }, [enabled, lastEventAt]);

  useEffect(() => {
    if (!enabled && subscribers === 0) {
      closeConnection();
      store().setConnectionState({
        connected: false,
        connecting: false,
        error: null,
        reconnectAttempts: 0,
      });
    }
  }, [enabled]);

  return connectionState;
}
