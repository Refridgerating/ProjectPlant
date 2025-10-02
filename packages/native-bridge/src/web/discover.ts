import { WebPlugin } from "@capacitor/core";
import type { DiscoverPlugin, DiscoverOptions, DiscoverResult } from "../discover";
import {
  DEFAULT_DISCOVERY_HOST,
  DEFAULT_DISCOVERY_PORTS,
  DEFAULT_DISCOVERY_TIMEOUT_MS
} from "../discover";

const HEALTH_ENDPOINT = "/healthz";
const PROJECTS_ENDPOINT = "/projects.json";

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  if (typeof fetch !== "function") {
    throw new Error("Fetch API is not available in this environment");
  }

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

export class DiscoverWeb extends WebPlugin implements DiscoverPlugin {
  async discover(options?: DiscoverOptions): Promise<DiscoverResult | null> {
    const hostname = options?.hostname ?? DEFAULT_DISCOVERY_HOST;
    const ports = options?.ports && options.ports.length > 0 ? options.ports : DEFAULT_DISCOVERY_PORTS;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;

    for (const port of ports) {
      const baseUrl = `http://${hostname}:${port}`;

      try {
        const healthResponse = await fetchWithTimeout(`${baseUrl}${HEALTH_ENDPOINT}`, timeoutMs);
        if (!healthResponse.ok) {
          continue;
        }

        const projectsResponse = await fetchWithTimeout(`${baseUrl}${PROJECTS_ENDPOINT}`, timeoutMs);
        if (!projectsResponse.ok) {
          continue;
        }

        return {
          host: hostname,
          port,
          serviceType: "_http._tcp"
        };
      } catch (error) {
        if (isAbortError(error)) {
          continue;
        }
      }
    }

    return null;
  }
}
