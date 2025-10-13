import type { CacheEntry, CacheProvider } from "./types";

export class MemoryCache implements CacheProvider {
  private store = new Map<string, CacheEntry<unknown>>();

  read<TValue>(key: string): Promise<CacheEntry<TValue> | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return Promise.resolve(null);
    }

    return Promise.resolve(entry as CacheEntry<TValue>);
  }

  write<TValue>(entry: CacheEntry<TValue>): Promise<void> {
    this.store.set(entry.key, entry);
    return Promise.resolve();
  }

  invalidate(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  clear(): void {
    this.store.clear();
  }
}

export const createMemoryCache = (): MemoryCache => new MemoryCache();
