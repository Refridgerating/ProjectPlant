import type { CacheProvider } from "../cache/types";
import type { SourceAdapter, SourceFetchOptions, SourcePayload, SourceSignals, SourceTarget } from "./types";

const DEFAULT_GBIF_BASE_URL = "https://api.gbif.org/v1";
const DEFAULT_USER_AGENT = "ProjectPlantCareEngine/0.1.0";

export interface GbifAdapterOptions {
  baseUrl?: string;
  cache?: CacheProvider;
  facetLimit?: number;
  includeSpeciesHabitat?: boolean;
}

export interface GbifFacetCount {
  name?: string | null;
  count: number;
}

export interface GbifFacetResult {
  field: string;
  counts: GbifFacetCount[];
}

export interface GbifOccurrenceResponse {
  count: number;
  facets?: GbifFacetResult[];
  results?: unknown[];
}

export interface GbifSignals {
  habitats?: { name: string; count: number }[];
  seasonality?: { month: number; observationCount: number }[];
  occurrenceCount?: number;
  contextUrl?: string;
  speciesHabitats?: string[];
}

export class GbifAdapter implements SourceAdapter<GbifOccurrenceResponse, GbifSignals> {
  readonly id = "gbif";
  private readonly baseUrl: string;
  private readonly cache?: CacheProvider;
  private readonly facetLimit: number;
  private readonly includeSpeciesHabitat: boolean;

  constructor(options: GbifAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_GBIF_BASE_URL;
    this.cache = options.cache;
    this.facetLimit = options.facetLimit ?? 24;
    this.includeSpeciesHabitat = options.includeSpeciesHabitat ?? true;
  }

  async fetch(
    target: SourceTarget,
    options: SourceFetchOptions = {}
  ): Promise<SourcePayload<GbifOccurrenceResponse>> {
    const taxonKeyRaw = target.taxon.gbifId ?? target.taxon.otherIds?.gbif;
    if (!taxonKeyRaw) {
      throw new Error("GbifAdapter requires taxon.gbifId (numeric species key)");
    }

    const taxonKey =
      typeof taxonKeyRaw === "number" ? taxonKeyRaw : Number.parseInt(String(taxonKeyRaw), 10);
    if (!Number.isFinite(taxonKey)) {
      throw new Error(`Invalid GBIF taxon key: ${taxonKeyRaw}`);
    }

    const cache = options.cache ?? this.cache;
    const cacheKey = options.cacheKey ?? this.makeCacheKey(taxonKey, target.placeCode);
    const now = new Date().toISOString();

    if (cache && !options.forceRefresh) {
      const cached = await cache.read<GbifOccurrenceResponse>(cacheKey);
      if (cached) {
        return {
          raw: cached.value,
          context: {
            fetchedAt: cached.storedAt,
            fromCache: true,
            url: cached.metadata?.url as string | undefined
          }
        };
      }
    }

    const url = this.buildOccurrenceFacetUrl(taxonKey, target.placeCode);
    const response = await fetch(url, {
      signal: options.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": DEFAULT_USER_AGENT
      }
    });
    if (!response.ok) {
      throw new Error(`GBIF occurrence request failed: ${response.status} ${response.statusText}`);
    }

    const occurrence = (await response.json()) as GbifOccurrenceResponse;

    let speciesHabitats: string[] | undefined;
    if (this.includeSpeciesHabitat) {
      try {
        speciesHabitats = await this.fetchSpeciesHabitats(taxonKey, options.signal);
      } catch {
        // ignore species habitat fetch failures
      }
    }

    const raw = Object.assign({}, occurrence, speciesHabitats ? { speciesHabitats } : undefined);
    const context = { fetchedAt: now, fromCache: false as const, url };

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

  async parse(
    payload: SourcePayload<GbifOccurrenceResponse>
  ): Promise<SourceSignals<GbifSignals>> {
    const signals: GbifSignals = {
      habitats: this.extractHabitats(payload.raw),
      seasonality: this.extractSeasonality(payload.raw),
      occurrenceCount: payload.raw.count ?? undefined,
      contextUrl: payload.context.url,
      speciesHabitats: (payload.raw as any).speciesHabitats ?? undefined
    };

    return {
      signals,
      context: payload.context,
      evidence: payload.evidence
    };
  }

  private extractHabitats(raw: GbifOccurrenceResponse): GbifSignals["habitats"] {
    const habitatFacet = raw.facets?.find(
      (facet) => facet.field.toUpperCase() === "HABITAT"
    );
    if (!habitatFacet) return undefined;

    const entries = habitatFacet.counts
      .map((entry) => ({
        name: entry.name?.trim(),
        count: entry.count
      }))
      .filter((entry): entry is { name: string; count: number } => !!entry.name && entry.count > 0);

    return entries.length > 0 ? entries : undefined;
  }

  private extractSeasonality(raw: GbifOccurrenceResponse): GbifSignals["seasonality"] {
    const monthFacet = raw.facets?.find(
      (facet) => facet.field.toUpperCase() === "MONTH"
    );
    if (!monthFacet) return undefined;

    const entries = monthFacet.counts
      .map((entry) => ({
        month: Number.parseInt(entry.name ?? "", 10),
        observationCount: entry.count
      }))
      .filter(
        (entry): entry is { month: number; observationCount: number } =>
          Number.isInteger(entry.month) && entry.month >= 1 && entry.month <= 12 && entry.observationCount > 0
      );

    return entries.length > 0 ? entries : undefined;
  }

  private async fetchSpeciesHabitats(taxonKey: number, signal?: AbortSignal): Promise<string[] | undefined> {
    const url = `${this.baseUrl}/species/${taxonKey}`;
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: "application/json",
        "User-Agent": DEFAULT_USER_AGENT
      }
    });
    if (!response.ok) {
      throw new Error(`GBIF species request failed: ${response.status} ${response.statusText}`);
    }
    const species = (await response.json()) as { habitats?: string[]; habitat?: string | string[] };
    const rawHabitats = species.habitats ?? species.habitat;
    if (!rawHabitats) return undefined;
    const list = Array.isArray(rawHabitats) ? rawHabitats : [rawHabitats];
    const normalized = list
      .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : null))
      .filter((entry): entry is string => Boolean(entry));
    return normalized.length > 0 ? normalized : undefined;
  }

  private buildOccurrenceFacetUrl(taxonKey: number, placeCode?: string): string {
    const url = new URL(`${this.baseUrl}/occurrence/search`);
    url.searchParams.set("taxonKey", taxonKey.toString());
    url.searchParams.set("limit", "0");
    url.searchParams.append("facet", "month");
    url.searchParams.append("facet", "habitat");
    url.searchParams.set("facetLimit", this.facetLimit.toString());
    if (placeCode && placeCode.length === 2) {
      url.searchParams.set("country", placeCode.toUpperCase());
    }
    return url.toString();
  }

  private makeCacheKey(taxonKey: number, placeCode?: string): string {
    const suffix = placeCode ? `:${placeCode.toUpperCase()}` : "";
    return `${this.id}:${taxonKey}${suffix}`;
  }
}

export const createGbifAdapter = (options?: GbifAdapterOptions): GbifAdapter =>
  new GbifAdapter(options);
