import type { CacheProvider } from "../cache/types";
import type { Evidence } from "../schema";
import type {
  SourceAdapter,
  SourceFetchOptions,
  SourcePayload,
  SourceSignals,
  SourceTarget
} from "./types";

const DEFAULT_POWO_BASE_URL = "https://powo.science.kew.org/api/2";

export interface PowoAdapterOptions {
  baseUrl?: string;
  cache?: CacheProvider;
}

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (value == null) return undefined;
  const items = Array.isArray(value) ? value : [value];
  const normalized = items
    .map((item) => (typeof item === "string" ? item.trim() : undefined))
    .filter((item): item is string => Boolean(item));
  return normalized.length ? normalized : undefined;
};

const normalizeTextSnippets = (
  entries: { heading?: unknown; text?: unknown }[] | undefined
): { heading: string; text: string }[] | undefined => {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const normalized = entries
    .map((entry) => ({
      heading: typeof entry.heading === "string" ? entry.heading : "",
      text: typeof entry.text === "string" ? entry.text : ""
    }))
    .filter((entry) => entry.heading || entry.text);
  return normalized.length ? normalized : undefined;
};

export interface PowoTaxonRecord {
  id: string;
  name: string;
  family?: string;
  lifeform?: string | string[] | null;
  habitats?: string | string[] | null;
  biome?: string | string[] | null;
  distribution?: {
    native?: string | string[] | null;
    introduced?: string | string[] | null;
  };
  elevation?: {
    min?: number | null;
    max?: number | null;
  };
  references?: { title: string; url?: string }[];
  descriptions?: { heading: string; text: string }[];
  notes?: string;
  raw?: unknown;
}

export interface PowoSignals {
  lifeforms?: string[];
  habitats?: string[];
  biome?: string[];
  elevationMeters?: { min?: number; max?: number };
  nativeRegions?: string[];
  introducedRegions?: string[];
  textSnippets?: { heading: string; text: string }[];
  references?: { title: string; url?: string }[];
  notes?: string;
}

export class PowoAdapter implements SourceAdapter<PowoTaxonRecord, PowoSignals> {
  readonly id = "powo";
  private readonly baseUrl: string;
  private readonly cache?: CacheProvider;

  constructor(options: PowoAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_POWO_BASE_URL;
    this.cache = options.cache;
  }

  async fetch(target: SourceTarget, options: SourceFetchOptions = {}): Promise<SourcePayload<PowoTaxonRecord>> {
    const powoId = target.taxon.powoId;
    if (!powoId) {
      throw new Error("PowoAdapter requires taxon.powoId to fetch data");
    }

    const cache = options.cache ?? this.cache;
    const cacheKey = options.cacheKey ?? this.makeCacheKey(powoId);
    const now = new Date().toISOString();

    if (cache && !options.forceRefresh) {
      const cached = await cache.read<PowoTaxonRecord>(cacheKey);
      if (cached) {
        return {
          raw: cached.value,
          context: {
            url: cached.metadata?.url as string | undefined,
            fetchedAt: cached.storedAt,
            fromCache: true
          },
          evidence: cached.metadata?.evidence as Evidence[] | undefined
        };
      }
    }

    const url = this.resolveUrl(powoId);
    const response = await fetch(url, {
      signal: options.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "ProjectPlantCareEngine/0.1.0"
      }
    });
    if (!response.ok) {
      throw new Error(`POWO request failed: ${response.status} ${response.statusText}`);
    }

    const raw = (await response.json()) as PowoTaxonRecord;
    const context = { fetchedAt: now, url, fromCache: false as const };

    if (cache) {
      await cache.write({
        key: cacheKey,
        value: raw,
        storedAt: now,
        metadata: { url }
      });
    }

    return { raw, context };
  }

  async parse(payload: SourcePayload<PowoTaxonRecord>): Promise<SourceSignals<PowoSignals>> {
    const record = payload.raw;
    const signals: PowoSignals = {
      lifeforms: normalizeStringArray(record.lifeform),
      habitats: normalizeStringArray(record.habitats),
      biome: normalizeStringArray(record.biome),
      elevationMeters: record.elevation
        ? {
            min: record.elevation.min ?? undefined,
            max: record.elevation.max ?? undefined
          }
        : undefined,
      nativeRegions: normalizeStringArray(record.distribution?.native),
      introducedRegions: normalizeStringArray(record.distribution?.introduced),
      textSnippets: normalizeTextSnippets(record.descriptions),
      references: Array.isArray(record.references) && record.references.length ? record.references : undefined,
      notes: typeof record.notes === "string" ? record.notes : undefined
    };

    return {
      signals,
      context: payload.context,
      evidence: payload.evidence
    };
  }

  private resolveUrl(powoId: string): string {
    return `${this.baseUrl}/taxon/${encodeURIComponent(powoId)}`;
  }

  private makeCacheKey(powoId: string): string {
    return `${this.id}:${powoId}`;
  }
}

export const createPowoAdapter = (options?: PowoAdapterOptions): PowoAdapter =>
  new PowoAdapter(options);
