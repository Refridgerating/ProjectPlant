import { WebPlugin } from "@capacitor/core";
import type { SecureStoragePlugin } from "../secure-storage";

export class SecureStorageWeb extends WebPlugin implements SecureStoragePlugin {
  private readonly memory = new Map<string, string>();

  async getItem(options: { key: string }): Promise<{ value: string | null }> {
    if (this.hasBrowserStorage()) {
      return { value: window.localStorage.getItem(options.key) };
    }
    return { value: this.memory.get(options.key) ?? null };
  }

  async setItem(options: { key: string; value: string }): Promise<void> {
    if (this.hasBrowserStorage()) {
      window.localStorage.setItem(options.key, options.value);
      return;
    }
    this.memory.set(options.key, options.value);
  }

  async removeItem(options: { key: string }): Promise<void> {
    if (this.hasBrowserStorage()) {
      window.localStorage.removeItem(options.key);
      return;
    }
    this.memory.delete(options.key);
  }

  async clear(): Promise<void> {
    if (this.hasBrowserStorage()) {
      window.localStorage.clear();
      return;
    }
    this.memory.clear();
  }

  private hasBrowserStorage(): boolean {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  }
}
