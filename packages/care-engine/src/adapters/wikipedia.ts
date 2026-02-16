import type { CacheProvider } from "../cache/types";
import type { Evidence } from "../schema";
import type {
  SourceAdapter,
  SourceFetchOptions,
  SourcePayload,
  SourceSignals,
  SourceTarget
} from "./types";

const DEFAULT_WIKI_BASE_URL = "https://en.wikipedia.org/api/rest_v1";

export interface WikipediaAdapterOptions {
  baseUrl?: string;
  cache?: CacheProvider;
}

export interface WikipediaSummaryResponse {
  title?: string;
  extract?: string;
  description?: string;
  content_urls?: {
    desktop?: { page?: string };
    mobile?: { page?: string };
  };
}

export interface WikipediaSignals {
  summary?: string;
  description?: string;
}

export class WikipediaAdapter implements SourceAdapter<WikipediaSummaryResponse, WikipediaSignals> {
  readonly id = "wikipedia";
  private readonly baseUrl: string;
  private readonly cache?: CacheProvider;

  constructor(options: WikipediaAdapterOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_WIKI_BASE_URL;
    this.cache = options.cache;
  }

  async fetch(
    target: SourceTarget,
    options: SourceFetchOptions = {}
  ): Promise<SourcePayload<WikipediaSummaryResponse>> {
    const title = this.resolveTitle(target.taxon.canonicalName);
    if (!title) {
      throw new Error("WikipediaAdapter requires taxon.canonicalName");
    }

    const cache = options.cache ?? this.cache;
    const cacheKey = options.cacheKey ?? `${this.id}:${title.toLowerCase()}`;
    const now = new Date().toISOString();

    if (cache && !options.forceRefresh) {
      const cached = await cache.read<WikipediaSummaryResponse>(cacheKey);
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

    const url = `${this.baseUrl}/page/summary/${encodeURIComponent(title)}`;
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`Wikipedia summary request failed: ${response.status} ${response.statusText}`);
    }

    const raw = (await response.json()) as WikipediaSummaryResponse;
    const context = { fetchedAt: now, fromCache: false as const, url: raw?.content_urls?.desktop?.page ?? url };

    if (cache) {
      await cache.write({
        key: cacheKey,
        value: raw,
        storedAt: now,
        metadata: { url: context.url }
      });
    }

    return { raw, context };
  }

  async parse(payload: SourcePayload<WikipediaSummaryResponse>): Promise<SourceSignals<WikipediaSignals>> {
    const raw = payload.raw;
    const signals: WikipediaSignals = {
      summary: raw.extract ?? undefined,
      description: raw.description ?? undefined
    };

    return {
      signals,
      context: payload.context,
      evidence: payload.evidence
    };
  }

  private resolveTitle(canonicalName?: string): string | undefined {
    if (!canonicalName) return undefined;
    return canonicalName.replace(/\s+/g, "_");
  }
}

export const createWikipediaAdapter = (options?: WikipediaAdapterOptions): WikipediaAdapter =>
  new WikipediaAdapter(options);
