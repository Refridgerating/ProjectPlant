import type { CareProfile } from "../schema";
import type { StorageAdapter, StorageContext } from "./types";

export class MemoryStorage implements StorageAdapter {
  private readonly store = new Map<string, { context: StorageContext; profile: CareProfile }>();

  constructor(private readonly keyFn: (profile: CareProfile) => string = defaultKeyFn) {}

  async write(context: StorageContext): Promise<void> {
    const key = this.keyFn(context.profile);
    this.store.set(key, { context, profile: context.profile });
  }

  async read(taxonId: string): Promise<CareProfile | null> {
    return this.store.get(taxonId)?.profile ?? null;
  }

  async *list(): AsyncIterable<CareProfile> {
    for (const entry of this.store.values()) {
      yield entry.profile;
    }
  }
}

const defaultKeyFn = (profile: CareProfile): string =>
  profile.taxon.powoId ?? profile.taxon.canonicalName.toLowerCase().replace(/\s+/g, "-");

export const createMemoryStorage = (
  keyFn?: (profile: CareProfile) => string
): MemoryStorage => new MemoryStorage(keyFn);
