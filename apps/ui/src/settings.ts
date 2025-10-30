export type RuntimeMode = "demo" | "live";

export type UiSettings = {
  mode: RuntimeMode;
  serverBaseUrl: string; // e.g. http://projectplant.local:80
  mqttUsername: string;
  mqttPassword: string;
  activeUserId: string;
  activeUserName: string;
};

const STORAGE_KEY = "projectplant:ui:settings";

const DEFAULT_SETTINGS: UiSettings = {
  mode: "demo",
  serverBaseUrl: "",
  mqttUsername: "",
  mqttPassword: "",
  activeUserId: "",
  activeUserName: "",
};

export function getSettings(): UiSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return normalize(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSettings(next: UiSettings): void {
  const normalized = normalize(next);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

function normalize(value: Partial<UiSettings>): UiSettings {
  const mode: RuntimeMode = value.mode === "live" ? "live" : "demo";
  const serverBaseUrl = typeof value.serverBaseUrl === "string" ? value.serverBaseUrl.trim() : "";
  const mqttUsername = typeof value.mqttUsername === "string" ? value.mqttUsername : "";
  const mqttPassword = typeof value.mqttPassword === "string" ? value.mqttPassword : "";
  const activeUserId = typeof value.activeUserId === "string" ? value.activeUserId.trim() : "";
  const activeUserName = typeof value.activeUserName === "string" ? value.activeUserName.trim() : "";
  return { mode, serverBaseUrl, mqttUsername, mqttPassword, activeUserId, activeUserName };
}

export function getApiBaseUrlSync(): string {
  // Returns the base for REST calls, including the /api/v1 prefix.
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiSettings>;
      const base = typeof parsed.serverBaseUrl === "string" ? parsed.serverBaseUrl.trim() : "";
      if (base) {
        const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
        return `${trimmed}/api/v1`;
      }
    }
  } catch {
    // ignore, fall back to relative
  }
  return "/api/v1";
}

export function getActiveUserIdSync(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiSettings>;
      const userId = typeof parsed.activeUserId === "string" ? parsed.activeUserId.trim() : "";
      return userId;
    }
  } catch {
    // ignore
  }
  return "";
}

export function getActiveUserNameSync(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiSettings>;
      const name = typeof parsed.activeUserName === "string" ? parsed.activeUserName.trim() : "";
      return name;
    }
  } catch {
    // ignore
  }
  return "";
}

export type TestResult = { ok: boolean; message: string };

export async function testRestConnection(baseUrl: string): Promise<TestResult> {
  const trimmed = (baseUrl || "").replace(/\/$/, "");
  const url = `${trimmed || ""}/api/v1/info`;
  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}` };
    }
    return { ok: true, message: "OK" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "Unknown error");
    return { ok: false, message: msg };
  }
}

export type DiscoverResult = { host: string; port: number; via: "web" } | null;

export async function discoverServer(): Promise<DiscoverResult> {
  // Web fallback: try projectplant.local on common ports
  const hostname = "projectplant.local";
  const ports = [80, 8080];
  const tryHealth = async (url: string) => {
    try {
      const res = await fetch(url, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  };
  for (const port of ports) {
    const base = `http://${hostname}:${port}`;
    const healthy = await tryHealth(`${base}/healthz`);
    if (!healthy) continue;
    const hasProjects = await tryHealth(`${base}/projects.json`);
    if (!hasProjects) continue;
    return { host: hostname, port, via: "web" };
  }
  return null;
}
