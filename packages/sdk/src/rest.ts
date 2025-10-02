export interface HealthStatus {
  status: "ok" | "degraded" | "critical";
  version?: string;
  timestamp?: string;
}

export interface PotSummary {
  id: string;
  name: string;
  soilMoisture: number;
  temperature: number;
  humidity?: number;
  battery?: number;
  updatedAt: string;
}

export interface ValveState {
  id: string;
  potId: string;
  isOpen: boolean;
  flowRateLpm?: number;
}

export interface IrrigationZone {
  id: string;
  name: string;
  valves: ValveState[];
}

export interface CommandPayload {
  type: string;
  potId?: string;
  zoneId?: string;
  parameters?: Record<string, unknown>;
}

export interface RestClient {
  getHealth(): Promise<HealthStatus>;
  listPots(): Promise<PotSummary[]>;
  listZones(): Promise<IrrigationZone[]>;
  sendCommand(payload: CommandPayload): Promise<void>;
}

export interface RestClientOptions {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export function createRestClient(options: string | RestClientOptions): RestClient {
  const resolved = typeof options === "string"
    ? { baseUrl: options }
    : options;
  const baseUrl = normalizedBaseUrl(resolved.baseUrl);
  const fetchImpl = resolved.fetchImpl ?? globalFetch();
  const defaultHeaders = resolved.defaultHeaders ?? {};

  return {
    async getHealth() {
      return request<HealthStatus>(fetchImpl, baseUrl, "/healthz", {
        method: "GET",
        headers: defaultHeaders
      });
    },
    async listPots() {
      return request<PotSummary[]>(fetchImpl, baseUrl, "/pots", {
        method: "GET",
        headers: defaultHeaders
      });
    },
    async listZones() {
      return request<IrrigationZone[]>(fetchImpl, baseUrl, "/irrigation/zones", {
        method: "GET",
        headers: defaultHeaders
      });
    },
    async sendCommand(payload: CommandPayload) {
      await request<void>(fetchImpl, baseUrl, "/command", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...defaultHeaders
        },
        body: JSON.stringify(payload)
      });
    }
  };
}

interface RequestOptions {
  method: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
}

async function request<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  path: string,
  options: RequestOptions
): Promise<T> {
  const url = buildUrl(baseUrl, path);
  const response = await fetchImpl(url, {
    method: options.method,
    headers: options.headers,
    body: options.body ?? null
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status} ${response.statusText}) for ${path}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function normalizedBaseUrl(baseUrl: string): string {
  if (!baseUrl) {
    throw new Error("baseUrl is required for RestClient");
  }
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function buildUrl(base: string, path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function globalFetch(): typeof fetch {
  if (typeof fetch === "function") {
    return fetch.bind(globalThis);
  }
  throw new Error("fetch is not available in the current environment");
}
