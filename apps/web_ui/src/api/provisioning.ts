import { getApiBaseUrlSync } from "../settings";

export type ProvisioningMethod = "ble" | "softap" | string;

export type ProvisionedDevice = {
  id: string;
  topic?: string;
  online: boolean;
  last_seen: number;
  first_seen?: number;
  retained?: boolean;
  state?: string;
  fresh?: boolean;
};

export type ProvisionWaitResponse = {
  status: "online" | "timeout";
  device: ProvisionedDevice | null;
  method?: ProvisioningMethod | null;
  elapsed?: number;
};

export interface WaitForProvisionOptions {
  deviceId?: string;
  method?: ProvisioningMethod;
  timeoutSeconds?: number;
  requireFresh?: boolean;
  signal?: AbortSignal;
}

export function normalizeDeviceId(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (cleaned.length !== 12) {
    return undefined;
  }
  return cleaned;
}

export async function waitForProvision(options: WaitForProvisionOptions = {}): Promise<ProvisionWaitResponse> {
  const base = getApiBaseUrlSync();
  const payload: Record<string, unknown> = {
    timeout: clamp(options.timeoutSeconds ?? 120, 5, 300),
    require_fresh: options.requireFresh ?? true,
  };

  if (options.method) {
    payload.method = options.method;
  }

  const normalizedId = normalizeDeviceId(options.deviceId);
  if (normalizedId) {
    payload.device_id = normalizedId;
  }

  const response = await fetch(`${base}/provision/wait`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // ignore read errors
    }
    const info = detail ? `: ${detail}` : "";
    throw new Error(`Provision wait failed (${response.status})${info}`);
  }

  return (await response.json()) as ProvisionWaitResponse;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
