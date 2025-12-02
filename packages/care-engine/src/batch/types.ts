import type { SourceAdapter, SourceFetchOptions, ParseOptions, SourceTarget } from "../adapters";
import type { PowoSignals, PowoTaxonRecord } from "../adapters/powo";
import type { InatPayload, InatSignals } from "../adapters/inat";
import type { GbifOccurrenceResponse, GbifSignals } from "../adapters/gbif";
import type { RuleBasedCareEngine } from "../engine/rule-engine";
import type { StorageAdapter } from "../storage/types";
import type { CareProfile } from "../schema";
import type { AdapterSignalBundle } from "../engine/signal-collector";

export interface AdapterBundle {
  powo: SourceAdapter<PowoTaxonRecord, PowoSignals>;
  inat?: SourceAdapter<InatPayload, InatSignals>;
  gbif?: SourceAdapter<GbifOccurrenceResponse, GbifSignals>;
}

export interface BatchBuilderOptions {
  adapters: AdapterBundle;
  careEngine: RuleBasedCareEngine;
  storage: StorageAdapter;
  runId?: string;
  powoFetchOptions?: SourceFetchOptions;
  powoParseOptions?: ParseOptions;
  inatFetchOptions?: SourceFetchOptions;
  inatParseOptions?: ParseOptions;
  gbifFetchOptions?: SourceFetchOptions;
  gbifParseOptions?: ParseOptions;
  onProfileGenerated?: (context: { job: TaxonJob; profile: CareProfile }) => void | Promise<void>;
  failOnInatError?: boolean;
  failOnGbifError?: boolean;
  onAdapterError?: (context: { job: TaxonJob; adapter: "powo" | "inat" | "gbif"; error: unknown }) => void | Promise<void>;
}

export interface TaxonJob extends SourceTarget {
  id: string;
  metadata?: Record<string, unknown>;
}

export interface BatchResult {
  processed: number;
  successes: number;
  failures: BatchFailure[];
}

export interface BatchFailure {
  job: TaxonJob;
  reason: string;
  error?: unknown;
}

export interface BatchBuilder {
  run(jobs: TaxonJob[]): Promise<BatchResult>;
  buildOne(job: TaxonJob): Promise<CareProfile>;
}

export type SignalBundle = AdapterSignalBundle;
