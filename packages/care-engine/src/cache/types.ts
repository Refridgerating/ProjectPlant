export interface CacheEntry<TValue> {
  key: string;
  value: TValue;
  storedAt: string;
  metadata?: Record<string, unknown>;
}

export interface CacheProvider {
  read<TValue>(key: string): Promise<CacheEntry<TValue> | null>;
  write<TValue>(entry: CacheEntry<TValue>): Promise<void>;
  invalidate(key: string): Promise<void>;
}
