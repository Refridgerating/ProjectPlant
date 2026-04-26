import { Capacitor } from "@capacitor/core";
import { discoverPi } from "@projectplant/sdk";

export type RuntimeMode = "demo" | "live";

export type EffectiveAccessSnapshot = {
  accountId: string;
  email: string;
  systemRole: string;
  isPrimaryMaster: boolean;
  isBackupMaster: boolean;
  masterControlsEnabled: boolean;
  capabilities: string[];
  scopes: string[];
  organizations: string[];
  sites: string[];
  hubs: string[];
  mfaRequired: boolean;
  mfaSatisfied: boolean;
};

export type UiSettings = {
  mode: RuntimeMode;
  serverBaseUrl: string;
  mqttUsername: string;
  mqttPassword: string;
  authToken: string;
  authTokenExpiresAt: number | null;
  activeUserId: string;
  activeUserName: string;
  authMode: string;
  controlPlaneUrl: string;
  fleetConsoleUrl: string;
  mfaSatisfied: boolean;
  effectiveAccess: EffectiveAccessSnapshot | null;
};

export type TestResult = { ok: boolean; message: string };
export type DiscoverResult = { host: string; port: number; via: "native" | "web" } | null;

const STORAGE_KEY = "projectplant:ui:settings";
const SETTINGS_CHANGED_EVENT = "projectplant:settings-changed";
const REST_DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_PORTS = [...Array.from({ length: 11 }, (_, index) => 8000 + index), 8080, 80];
const DEBUG_MASTER_USER_ID = ((import.meta.env.VITE_DEBUG_MASTER_USER_ID ?? "") as string).trim();
const DEBUG_MASTER_USER_NAME = ((import.meta.env.VITE_DEBUG_MASTER_USER_NAME ?? "") as string).trim();

const DEFAULT_SETTINGS: UiSettings = {
  mode: "demo",
  serverBaseUrl: "",
  mqttUsername: "",
  mqttPassword: "",
  authToken: "",
  authTokenExpiresAt: null,
  activeUserId: DEBUG_MASTER_USER_ID,
  activeUserName: DEBUG_MASTER_USER_NAME || (DEBUG_MASTER_USER_ID ? "Debug Master" : ""),
  authMode: "local_compat",
  controlPlaneUrl: "",
  fleetConsoleUrl: "",
  mfaSatisfied: false,
  effectiveAccess: null,
};

interface StorageAdapter {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
}

let cachedSettings: UiSettings = { ...DEFAULT_SETTINGS };
let hasLoaded = false;
let storagePromise: Promise<StorageAdapter> | null = null;

export async function initSettings(): Promise<UiSettings> {
  cachedSettings = await loadFromStorage();
  hasLoaded = true;
  return { ...cachedSettings };
}

export function getSettings(): UiSettings {
  ensureSyncHydrated();
  return { ...cachedSettings };
}

export function setSettings(next: UiSettings): void {
  const normalized = normalize(next);
  cachedSettings = normalized;
  hasLoaded = true;
  void persistSettings(normalized);
  dispatchSettingsChanged();
}

export function getApiBaseUrlSync(): string {
  const base = getSettings().serverBaseUrl;
  if (base) {
    const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
    return `${trimmed}/api/v1`;
  }
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/v1`;
  }
  return "/api/v1";
}

export function getApiTargetLabelSync(): string {
  const base = getApiBaseUrlSync();
  if (base.startsWith("/") && typeof window !== "undefined") {
    return `${window.location.origin}${base}`;
  }
  return base;
}

export function getActiveUserIdSync(): string {
  return getSettings().activeUserId || DEBUG_MASTER_USER_ID;
}

export function getActiveUserNameSync(): string {
  return getSettings().activeUserName;
}

export function getAuthTokenSync(): string {
  const { authToken, authTokenExpiresAt } = getSettings();
  if (!authToken) {
    return "";
  }
  if (authTokenExpiresAt !== null && Date.now() >= authTokenExpiresAt) {
    return "";
  }
  return authToken;
}

export async function testRestConnection(baseUrl: string): Promise<TestResult> {
  const trimmed = (baseUrl || "").replace(/\/$/, "");
  const url = `${trimmed || ""}/api/v1/info`;
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}` };
    }
    return { ok: true, message: "OK" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "Unknown error");
    return { ok: false, message: msg };
  }
}

export async function discoverServer(): Promise<DiscoverResult> {
  const result = await discoverPi({
    hostname: resolveDiscoveryHostname(),
    ports: DISCOVERY_PORTS,
    timeoutMs: REST_DISCOVERY_TIMEOUT_MS,
  }).catch(() => null);
  if (!result) {
    return null;
  }
  return {
    host: result.host,
    port: result.port,
    via: result.via,
  };
}

function normalize(value: Partial<UiSettings>): UiSettings {
  const mode: RuntimeMode = value.mode === "live" ? "live" : "demo";
  const serverBaseUrl = typeof value.serverBaseUrl === "string" ? value.serverBaseUrl.trim() : "";
  const mqttUsername = typeof value.mqttUsername === "string" ? value.mqttUsername : "";
  const mqttPassword = typeof value.mqttPassword === "string" ? value.mqttPassword : "";
  const authToken = typeof value.authToken === "string" ? value.authToken.trim() : "";
  const authTokenExpiresAt =
    typeof value.authTokenExpiresAt === "number" && Number.isFinite(value.authTokenExpiresAt)
      ? value.authTokenExpiresAt
      : null;
  const activeUserId = typeof value.activeUserId === "string" ? value.activeUserId.trim() : "";
  const activeUserName = typeof value.activeUserName === "string" ? value.activeUserName.trim() : "";
  const authMode = typeof value.authMode === "string" ? value.authMode.trim() || "local_compat" : "local_compat";
  const controlPlaneUrl = typeof value.controlPlaneUrl === "string" ? value.controlPlaneUrl.trim() : "";
  const fleetConsoleUrl = typeof value.fleetConsoleUrl === "string" ? value.fleetConsoleUrl.trim() : "";
  const mfaSatisfied = value.mfaSatisfied === true;
  const effectiveAccess =
    value.effectiveAccess && typeof value.effectiveAccess === "object"
      ? (value.effectiveAccess as EffectiveAccessSnapshot)
      : null;
  return {
    mode,
    serverBaseUrl,
    mqttUsername,
    mqttPassword,
    authToken,
    authTokenExpiresAt,
    activeUserId,
    activeUserName,
    authMode,
    controlPlaneUrl,
    fleetConsoleUrl,
    mfaSatisfied,
    effectiveAccess,
  };
}

function ensureSyncHydrated(): void {
  if (hasLoaded) {
    return;
  }
  cachedSettings = loadFromLocalStorageSync();
  hasLoaded = true;
}

function loadFromLocalStorageSync(): UiSettings {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return { ...DEFAULT_SETTINGS };
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    return normalize(JSON.parse(raw) as Partial<UiSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function loadFromStorage(): Promise<UiSettings> {
  try {
    const storage = await getStorage();
    const raw = await storage.get();
    if (!raw) {
      return loadFromLocalStorageSync();
    }
    return normalize(JSON.parse(raw) as Partial<UiSettings>);
  } catch {
    return loadFromLocalStorageSync();
  }
}

async function persistSettings(normalized: UiSettings): Promise<void> {
  try {
    const storage = await getStorage();
    await storage.set(JSON.stringify(normalized));
  } catch {
    // ignore persistence failures and keep the in-memory state
  }
}

async function getStorage(): Promise<StorageAdapter> {
  if (!storagePromise) {
    storagePromise = resolveStorage();
  }
  return storagePromise;
}

async function resolveStorage(): Promise<StorageAdapter> {
  if (isNativePlatform()) {
    const native = await createCapacitorAdapter();
    if (native) {
      return native;
    }
  }
  if (hasLocalStorage()) {
    return createLocalStorageAdapter();
  }
  return createMemoryAdapter();
}

function hasLocalStorage(): boolean {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return false;
    }
    const key = "__projectplant_settings_check__";
    window.localStorage.setItem(key, "1");
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function createLocalStorageAdapter(): StorageAdapter {
  return {
    async get() {
      return window.localStorage.getItem(STORAGE_KEY);
    },
    async set(value: string) {
      window.localStorage.setItem(STORAGE_KEY, value);
    },
    async remove() {
      window.localStorage.removeItem(STORAGE_KEY);
    },
  };
}

async function createCapacitorAdapter(): Promise<StorageAdapter | null> {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    try {
      const nativeModule = await import("@projectplant/native-bridge/secure-storage");
      const secureStorage = nativeModule.SecureStorage;
      if (secureStorage) {
        return {
          async get() {
            const result = await secureStorage.getItem({ key: STORAGE_KEY });
            return result?.value ?? null;
          },
          async set(value: string) {
            await secureStorage.setItem({ key: STORAGE_KEY, value });
          },
          async remove() {
            await secureStorage.removeItem({ key: STORAGE_KEY });
          },
        };
      }
    } catch {
      // fall through to Preferences when secure storage is unavailable
    }

    const preferencesModule = await import("@capacitor/preferences");
    const preferences = preferencesModule.Preferences;
    if (!preferences) {
      return null;
    }
    return {
      async get() {
        const result = await preferences.get({ key: STORAGE_KEY });
        return result.value ?? null;
      },
      async set(value: string) {
        await preferences.set({ key: STORAGE_KEY, value });
      },
      async remove() {
        await preferences.remove({ key: STORAGE_KEY });
      },
    };
  } catch {
    return null;
  }
}

function createMemoryAdapter(): StorageAdapter {
  let value: string | null = null;
  return {
    async get() {
      return value;
    },
    async set(next: string) {
      value = next;
    },
    async remove() {
      value = null;
    },
  };
}

function dispatchSettingsChanged(): void {
  try {
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  } catch {
    // ignore event dispatch failures
  }
}

function resolveDiscoveryHostname(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const host = window.location.hostname?.trim();
  return host || undefined;
}

function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string, timeoutMs = REST_DISCOVERY_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { method: "GET", signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
