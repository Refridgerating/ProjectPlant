import { describe, it, expect, vi } from "vitest";
import type {
  SourceAdapter,
  SourcePayload,
  SourceSignals,
  SourceTarget,
  SourceFetchOptions,
  ParseOptions
} from "../src/adapters";
import type { PowoSignals, PowoTaxonRecord } from "../src/adapters/powo";
import type { InatSignals, InatPayload } from "../src/adapters/inat";
import { RuleBasedCareEngine } from "../src";
import { CareProfileBatchBuilder } from "../src/batch";
import { createMemoryStorage } from "../src/storage";

const fakePowoSignals: PowoSignals = {
  lifeforms: ["vine"],
  habitats: ["rainforest understory"],
  biome: ["rainforest"]
};

class FakePowoAdapter implements SourceAdapter<PowoTaxonRecord, PowoSignals> {
  readonly id = "powo";

  async fetch(target: SourceTarget, _options?: SourceFetchOptions): Promise<SourcePayload<PowoTaxonRecord>> {
    return {
      raw: { id: target.taxon.powoId ?? "fake", name: target.taxon.canonicalName },
      context: {
        fetchedAt: "2024-10-12T00:00:00.000Z",
        fromCache: false,
        url: "https://example.com/powo/fake"
      }
    };
  }

  async parse(
    payload: SourcePayload<PowoTaxonRecord>,
    _options?: ParseOptions
  ): Promise<SourceSignals<PowoSignals>> {
    return {
      signals: fakePowoSignals,
      context: payload.context
    };
  }
}

class FakeInatAdapter implements SourceAdapter<InatPayload, InatSignals> {
  readonly id = "inat";
  constructor(private readonly shouldFail = false) {}

  async fetch(_target: SourceTarget, _options?: SourceFetchOptions): Promise<SourcePayload<InatPayload>> {
    if (this.shouldFail) {
      throw new Error("inat fetch failed");
    }
    return {
      raw: { taxon: { id: 1 } } as unknown as InatPayload,
      context: {
        fetchedAt: "2024-10-12T00:00:00.000Z",
        fromCache: false,
        url: "https://api.inaturalist.org/v1/taxa/1"
      }
    };
  }

  async parse(
    payload: SourcePayload<InatPayload>,
    _options?: ParseOptions
  ): Promise<SourceSignals<InatSignals>> {
    return {
      signals: {
        globalEstablishment: "native"
      },
      context: payload.context
    };
  }
}

const makeJob = () => ({
  id: "monstera",
  taxon: {
    canonicalName: "Monstera deliciosa",
    powoId: "327761-2",
    inatId: 48234
  }
});

describe("CareProfileBatchBuilder", () => {
  it("builds and stores profiles", async () => {
    const careEngine = new RuleBasedCareEngine();
    const storage = createMemoryStorage();

    const builder = new CareProfileBatchBuilder({
      adapters: {
        powo: new FakePowoAdapter(),
        inat: new FakeInatAdapter()
      },
      careEngine,
      storage,
      runId: "test-run"
    });

    const profile = await builder.buildOne(makeJob());

    expect(profile.light?.value).toContain("bright_indirect");

    if (storage.list) {
      const stored: string[] = [];
      for await (const item of storage.list()) {
        stored.push(item.taxon.canonicalName);
      }
      expect(stored).toContain("Monstera deliciosa");
    }
  });

  it("skips iNaturalist errors when configured", async () => {
    const careEngine = new RuleBasedCareEngine();
    const storage = createMemoryStorage();
    const onAdapterError = vi.fn();

    const builder = new CareProfileBatchBuilder({
      adapters: {
        powo: new FakePowoAdapter(),
        inat: new FakeInatAdapter(true)
      },
      careEngine,
      storage,
      runId: "test-run",
      failOnInatError: false,
      onAdapterError
    });

    const result = await builder.run([makeJob()]);
    expect(result.successes).toBe(1);
    expect(onAdapterError).toHaveBeenCalled();
  });
});
