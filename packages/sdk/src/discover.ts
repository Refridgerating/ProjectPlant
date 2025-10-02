import { Capacitor } from "@capacitor/core";
import {
  DiscoverBridge,
  type DiscoverOptions,
  type DiscoverResult,
  DEFAULT_DISCOVERY_HOST,
  DEFAULT_DISCOVERY_PORTS,
  DEFAULT_DISCOVERY_TIMEOUT_MS
} from "@native/discover";

export interface PiDiscoveryResult extends DiscoverResult {
  via: "native" | "web";
}

export async function discoverPi(options?: DiscoverOptions): Promise<PiDiscoveryResult | null> {
  if (Capacitor.isNativePlatform()) {
    const nativeResult = await tryNativeDiscovery(options);
    if (nativeResult) {
      return { ...nativeResult, via: "native" };
    }
  }

  const fallbackResult = await tryWebFallback(options);
  return fallbackResult ? { ...fallbackResult, via: "web" } : null;
}

async function tryNativeDiscovery(options?: DiscoverOptions): Promise<DiscoverResult | null> {
  try {
    const result = await DiscoverBridge.discover(options);
    return result ?? null;
  } catch {
    return null;
  }
}

async function tryWebFallback(options?: DiscoverOptions): Promise<DiscoverResult | null> {
  if (typeof fetch !== "function") {
    return null;
  }

  const hostname = options?.hostname ?? DEFAULT_DISCOVERY_HOST;
  const ports = options?.ports && options.ports.length > 0 ? options.ports : DEFAULT_DISCOVERY_PORTS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;

  for (const port of ports) {
    const baseUrl = `http://${hostname}:${port}`;

    const healthy = await checkEndpoint(`${baseUrl}/healthz`, timeoutMs);
    if (!healthy) {
      continue;
    }

    const projectsOk = await checkEndpoint(`${baseUrl}/projects.json`, timeoutMs);
    if (!projectsOk) {
      continue;
    }

    return {
      host: hostname,
      port,
      serviceType: "_http._tcp"
    };
  }

  return null;
}

async function checkEndpoint(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(url, timeoutMs);
    return response.ok;
  } catch (error) {
    if (isAbortError(error)) {
      return false;
    }
    return false;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  if (typeof AbortController === "undefined") {
    return fetch(url);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return error instanceof Error && error.name === "AbortError";
}
