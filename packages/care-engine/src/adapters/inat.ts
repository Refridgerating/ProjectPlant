import type { CacheProvider } from "../cache/types";
import type { Evidence } from "../schema";
import type {
  SourceAdapter,
  SourceFetchOptions,
  SourcePayload,
  SourceSignals,
  SourceTarget
} from "./types";

const DEFAULT_INAT_BASE_URL = "https://api.inaturalist.org/v1";

export interface InatAdapterOptions {
  baseUrl?: string;
  cache?: CacheProvider;
  includeSeasonality?: boolean;
}

export interface InatTaxonRecord {
  id: number;
  name: string;
  preferred_common_name?: string;
  wikipedia_url?: string;
  wikipedia_summary?: string;
  iconic_taxon_name?: string;
  establishment_means?: string;
  establishment_means_by_place?: InatEstablishment[];
  ancestry?: string;
  observations_count?: number;
  default_photo?: { medium_url?: string; attribution?: string };
}

export interface InatEstablishment {
  establishment_means: string | null;
  place_id: number;
  place?: { id: number; name: string; display_name?: string };
}

export interface InatSeasonalityResponse {
  results: {
    month?: Record<string, number>;
  };
}

export interface InatSignals {
  establishment?: {
    placeId: number;
    placeName?: string;
    status: string;
  }[];
  globalEstablishment?: string;
  seasonality?: { month: number; observationCount: number }[];
  wikipediaSummary?: string;
}

export interface InatPayload {
  taxon: InatTaxonRecord;
  seasonality?: InatSeasonalityResponse;
}

export class InatAdapter implements SourceAdapter<InatPayload, InatSignals> {
  readonly id = "inat";
  private readonly baseUrl: string;
  private readonly cache?: CacheProvider;
  private readonly includeSeasonality: boolean;

  constructor(options: InatAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_INAT_BASE_URL;
    this.cache = options.cache;
    this.includeSeasonality = options.includeSeasonality ?? true;
  }

  async fetch(target: SourceTarget, options: SourceFetchOptions = {}): Promise<SourcePayload<InatPayload>> {
    const inatId = target.taxon.inatId;
    if (typeof inatId !== "number") {
      throw new Error("InatAdapter requires a numeric taxon.inatId");
    }

    const cache = options.cache ?? this.cache;
    const cacheKey = options.cacheKey ?? this.makeCacheKey(inatId, target.placeCode);
    const now = new Date().toISOString();

    if (cache && !options.forceRefresh) {
      const cached = await cache.read<InatPayload>(cacheKey);
      if (cached) {
        return {
          raw: cached.value,
          context: {
            fetchedAt: cached.storedAt,
            fromCache: true,
            url: cached.metadata?.url as string | undefined
          },
          evidence: cached.metadata?.evidence as Evidence[] | undefined
        };
      }
    }

    const taxonUrl = this.buildTaxonUrl(inatId, target.placeCode);
    const taxonResponse = await fetch(taxonUrl, { signal: options.signal });
    if (!taxonResponse.ok) {
      throw new Error(`iNaturalist taxon request failed: ${taxonResponse.status} ${taxonResponse.statusText}`);
    }

    const taxonResult = (await taxonResponse.json()) as { results: InatTaxonRecord[] };
    const record = taxonResult.results?.[0];
    if (!record) {
      throw new Error(`iNaturalist taxon ${inatId} returned no results`);
    }

    let seasonality: InatSeasonalityResponse | undefined;
    if (this.includeSeasonality) {
      const seasonalityUrl = this.buildSeasonalityUrl(inatId, target.placeCode);
      const seasonalityResponse = await fetch(seasonalityUrl, { signal: options.signal });
      if (seasonalityResponse.ok) {
        seasonality = (await seasonalityResponse.json()) as InatSeasonalityResponse;
      }
    }

    const payload: InatPayload = { taxon: record, seasonality };
    const context = {
      fetchedAt: now,
      fromCache: false as const,
      url: taxonUrl
    };

    if (cache) {
      await cache.write({
        key: cacheKey,
        value: payload,
        storedAt: now,
        metadata: { url: taxonUrl }
      });
    }

    return { raw: payload, context };
  }

  async parse(payload: SourcePayload<InatPayload>): Promise<SourceSignals<InatSignals>> {
    const taxon = payload.raw.taxon;
    const establishment = (taxon.establishment_means_by_place ?? []).map((record) => ({
      placeId: record.place_id,
      placeName: record.place?.display_name ?? record.place?.name,
      status: record.establishment_means ?? "unknown"
    }));

    const seasonalityEntries = payload.raw.seasonality?.results.month
      ? Object.entries(payload.raw.seasonality.results.month).map(([month, count]) => ({
          month: Number.parseInt(month, 10),
          observationCount: count
        }))
      : undefined;

    const signals: InatSignals = {
      establishment: establishment.length > 0 ? establishment : undefined,
      globalEstablishment: taxon.establishment_means ?? undefined,
      seasonality: seasonalityEntries,
      wikipediaSummary: taxon.wikipedia_summary ?? undefined
    };

    return {
      signals,
      context: payload.context,
      evidence: payload.evidence
    };
  }

  private buildTaxonUrl(taxonId: number, placeCode?: string): string {
    const url = new URL(`${this.baseUrl}/taxa/${taxonId}`);
    url.searchParams.set("all_names", "true");
    url.searchParams.set("locale", "en");
    if (placeCode) {
      url.searchParams.set("preferred_place_id", placeCode);
    }
    return url.toString();
  }

  private buildSeasonalityUrl(taxonId: number, placeCode?: string): string {
    const url = new URL(`${this.baseUrl}/observations/histogram`);
    url.searchParams.set("interval", "month");
    url.searchParams.set("taxon_id", taxonId.toString());
    url.searchParams.set("verifiable", "true");
    if (placeCode) {
      url.searchParams.set("place_id", placeCode);
    }
    return url.toString();
  }

  private makeCacheKey(taxonId: number, placeCode?: string): string {
    return placeCode ? `${this.id}:${taxonId}:p:${placeCode}` : `${this.id}:${taxonId}`;
  }
}

export const createInatAdapter = (options?: InatAdapterOptions): InatAdapter => new InatAdapter(options);
