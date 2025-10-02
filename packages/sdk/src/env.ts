export type RuntimeMode = "demo" | "live";

export interface RuntimeEnv {
  mode: RuntimeMode;
  baseUrl?: string;
  mqttUrl?: string;
}

export const DEFAULT_ENV: RuntimeEnv = { mode: "demo" };

const STORAGE_KEY = "projectplant:sdk:env";

interface StorageAdapter {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  remove(): Promise<void>;
}

let cachedEnv: RuntimeEnv = { ...DEFAULT_ENV };
let hasLoaded = false;
let storagePromise: Promise<StorageAdapter> | null = null;

export async function getEnv(): Promise<RuntimeEnv> {
  if (!hasLoaded) {
    cachedEnv = await loadFromStorage();
    hasLoaded = true;
  }
  return { ...cachedEnv };
}

export function getEnvSync(): RuntimeEnv {
  return { ...cachedEnv };
}

export async function setEnv(next: RuntimeEnv): Promise<void> {
  const normalized = normalizeEnv(next);
  cachedEnv = normalized;
  hasLoaded = true;
  const storage = await getStorage();
  await storage.set(JSON.stringify(normalized));
}

export async function resetEnv(): Promise<void> {
  cachedEnv = { ...DEFAULT_ENV };
  const storage = await getStorage();
  await storage.remove();
}

async function loadFromStorage(): Promise<RuntimeEnv> {
  try {
    const storage = await getStorage();
    const raw = await storage.get();
    if (!raw) {
      return { ...DEFAULT_ENV };
    }
    const parsed = JSON.parse(raw) as Partial<RuntimeEnv>;
    return normalizeEnv(parsed);
  } catch {
    return { ...DEFAULT_ENV };
  }
}

function normalizeEnv(value: Partial<RuntimeEnv> | RuntimeEnv): RuntimeEnv {
  const mode = value.mode === "live" ? "live" : "demo";
  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl : undefined;
  const mqttUrl = typeof value.mqttUrl === "string" ? value.mqttUrl : undefined;
  return { mode, baseUrl, mqttUrl };
}

async function getStorage(): Promise<StorageAdapter> {
  if (!storagePromise) {
    storagePromise = resolveStorage();
  }
  return storagePromise;
}

async function resolveStorage(): Promise<StorageAdapter> {
  if (hasLocalStorage()) {
    return createLocalStorageAdapter();
  }
  const capacitor = await createCapacitorAdapter();
  if (capacitor) {
    return capacitor;
  }
  return createMemoryAdapter();
}

function hasLocalStorage(): boolean {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return false;
    }
    const key = "__projectplant_check__";
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
    }
  };
}

async function createCapacitorAdapter(): Promise<StorageAdapter | null> {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    // Prefer native secure storage (EncryptedSharedPreferences on Android)
    try {
      const native = await import("@projectplant/native-bridge");
      const Secure = native.SecureStorage ?? native.default?.SecureStorage;
      if (Secure) {
        return {
          async get() {
            const result = await Secure.getItem({ key: STORAGE_KEY });
            return result?.value ?? null;
          },
          async set(value: string) {
            await Secure.setItem({ key: STORAGE_KEY, value });
          },
          async remove() {
            await Secure.removeItem({ key: STORAGE_KEY });
          }
        };
      }
    } catch {
      // fall back to Preferences if SecureStorage not available
    }

    const module = await import("@capacitor/preferences");
    const Preferences = module.Preferences ?? module.default?.Preferences;
    if (!Preferences) {
      return null;
    }
    return {
      async get() {
        const result = await Preferences.get({ key: STORAGE_KEY });
        return result.value ?? null;
      },
      async set(value: string) {
        await Preferences.set({ key: STORAGE_KEY, value });
      },
      async remove() {
        await Preferences.remove({ key: STORAGE_KEY });
      }
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
    }
  };
}
