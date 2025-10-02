import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class LocalStorageMock {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const STORAGE_KEY = "projectplant:sdk:env";

describe("env", () => {
  let storage: LocalStorageMock;

  beforeEach(() => {
    vi.resetModules();
    storage = new LocalStorageMock();
    (globalThis as any).window = { localStorage: storage };
    (globalThis as any).localStorage = storage;
  });

  afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
  });

  it("persists environment changes to localStorage", async () => {
    const { getEnv, setEnv } = await import("../src/env");
    await setEnv({ mode: "live", baseUrl: "https://api.example.com", mqttUrl: "wss://mqtt.example.com" });
    expect(storage.getItem(STORAGE_KEY)).toContain("\"mode\":\"live\"");

    const env = await getEnv();
    expect(env).toEqual({
      mode: "live",
      baseUrl: "https://api.example.com",
      mqttUrl: "wss://mqtt.example.com"
    });
  });

  it("falls back to defaults when storage is corrupted", async () => {
    storage.setItem(STORAGE_KEY, "not-json");
    const { getEnv } = await import("../src/env");
    const env = await getEnv();
    expect(env.mode).toBe("demo");
  });
});
