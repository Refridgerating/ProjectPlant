import type { SourceSignals } from "../adapters";
import type { PowoSignals } from "../adapters/powo";
import type { InatSignals } from "../adapters/inat";
import type { CareProfile } from "../schema";
import type {
  BatchBuilder,
  BatchBuilderOptions,
  BatchFailure,
  BatchResult,
  SignalBundle,
  TaxonJob
} from "./types";

const nowIso = (): string => new Date().toISOString();

export class CareProfileBatchBuilder implements BatchBuilder {
  constructor(private readonly options: BatchBuilderOptions) {}

  async run(jobs: TaxonJob[]): Promise<BatchResult> {
    const failures: BatchFailure[] = [];
    let successes = 0;

    for (const job of jobs) {
      try {
        await this.buildOne(job);
        successes += 1;
      } catch (error: unknown) {
        failures.push({
          job,
          reason: error instanceof Error ? error.message : "Unknown error",
          error
        });
      }
    }

    return {
      processed: jobs.length,
      successes,
      failures
    };
  }

  async buildOne(job: TaxonJob): Promise<CareProfile> {
    const { adapters } = this.options;
    const powoSignals = await this.fetchPowoSignals(job);
    const bundle: SignalBundle = { powo: powoSignals };

    if (adapters.inat) {
      try {
        const inatSignals = await this.fetchInatSignals(job);
        if (inatSignals) {
          bundle.inat = inatSignals;
        }
      } catch (error) {
        if (this.options.failOnInatError) {
          throw error;
        }
      }
    }

    const generatedAt = nowIso();
    const profile = this.options.careEngine.map({
      target: job,
      signals: bundle,
      generatedAt
    });

    await this.options.storage.write({
      profile,
      generatedAt,
      runId: this.options.runId
    });

    if (this.options.onProfileGenerated) {
      await this.options.onProfileGenerated({ job, profile });
    }

    return profile;
  }

  private async fetchPowoSignals(job: TaxonJob): Promise<SourceSignals<PowoSignals>> {
    const { powo } = this.options.adapters;
    const fetchOptions = {
      ...this.options.powoFetchOptions,
      cacheKey: this.options.powoFetchOptions?.cacheKey ?? `powo:${job.id}`
    };
    let payload: Awaited<ReturnType<typeof powo.fetch>>;
    try {
      payload = await powo.fetch(job, fetchOptions);
    } catch (error) {
      if (this.options.onAdapterError) {
        await this.options.onAdapterError({ job, adapter: "powo", error });
      }
      throw error;
    }
    try {
      return await powo.parse(payload, this.options.powoParseOptions);
    } catch (error) {
      if (this.options.onAdapterError) {
        await this.options.onAdapterError({ job, adapter: "powo", error });
      }
      throw error;
    }
  }

  private async fetchInatSignals(job: TaxonJob): Promise<SourceSignals<InatSignals> | undefined> {
    const inatAdapter = this.options.adapters.inat;
    if (!inatAdapter) return undefined;

    const fetchOptions = {
      ...this.options.inatFetchOptions,
      cacheKey: this.options.inatFetchOptions?.cacheKey ?? `inat:${job.id}`
    };

    let payload: Awaited<ReturnType<typeof inatAdapter.fetch>>;
    try {
      payload = await inatAdapter.fetch(job, fetchOptions);
    } catch (error) {
      if (this.options.onAdapterError) {
        await this.options.onAdapterError({ job, adapter: "inat", error });
      }
      throw error;
    }

    try {
      return await inatAdapter.parse(payload, this.options.inatParseOptions);
    } catch (error) {
      if (this.options.onAdapterError) {
        await this.options.onAdapterError({ job, adapter: "inat", error });
      }
      throw error;
    }
  }
}
