import type { CareProfile, Evidence, TaxonReference } from "../schema";
import type { CacheProvider } from "../cache/types";

export interface SourceTarget {
  taxon: TaxonReference;
  /**
   * Optional ISO country or region code to scope the lookup when supported.
   */
  placeCode?: string;
}

export interface FetchContext {
  /**
   * Fully qualified URL used for the network request. Primarily for logging.
   */
  url?: string;
  /**
   * ISO timestamp indicating when the payload was fetched.
   */
  fetchedAt: string;
  /**
   * Whether the payload originated from cache instead of the network.
   */
  fromCache: boolean;
}

export interface SourcePayload<TRaw> {
  raw: TRaw;
  context: FetchContext;
  evidence?: Evidence[];
}

export interface SourceSignals<TSignals> {
  signals: TSignals;
  context: FetchContext;
  evidence?: Evidence[];
}

export interface SourceAdapter<TRaw, TSignals> {
  readonly id: string;
  fetch(target: SourceTarget, options?: SourceFetchOptions): Promise<SourcePayload<TRaw>>;
  parse(payload: SourcePayload<TRaw>, options?: ParseOptions): Promise<SourceSignals<TSignals>>;
}

export interface SourceFetchOptions {
  forceRefresh?: boolean;
  cache?: CacheProvider;
  /**
   * Allows adapters to stash raw payloads for offline auditing.
   */
  cacheKey?: string;
  signal?: AbortSignal;
}

export interface ParseOptions {
  /**
   * Optional hint to produce indoor/outdoor specific signals.
   */
  audience?: "indoor" | "outdoor" | "general";
}

export interface CareProfileBuilder {
  build(signals: Record<string, unknown>, target: SourceTarget): Promise<CareProfile>;
}
