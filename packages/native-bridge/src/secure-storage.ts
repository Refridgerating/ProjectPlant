import { registerPlugin } from "@capacitor/core";

export interface SecureStoragePlugin {
  getItem(options: { key: string }): Promise<{ value: string | null }>;
  setItem(options: { key: string; value: string }): Promise<void>;
  removeItem(options: { key: string }): Promise<void>;
  clear(): Promise<void>;
}

export const SecureStorage = registerPlugin<SecureStoragePlugin>("SecureStorage", {
  web: () => import("./web/secure-storage").then((m) => new m.SecureStorageWeb())
});

export function namespacedStorage(namespace: string) {
  const prefix = `${namespace}::`;
  return {
    async get(key: string) {
      const result = await SecureStorage.getItem({ key: `${prefix}${key}` });
      return result.value;
    },
    async set(key: string, value: string) {
      await SecureStorage.setItem({ key: `${prefix}${key}`, value });
    },
    async remove(key: string) {
      await SecureStorage.removeItem({ key: `${prefix}${key}` });
    },
    async clear() {
      await SecureStorage.clear();
    }
  };
}
