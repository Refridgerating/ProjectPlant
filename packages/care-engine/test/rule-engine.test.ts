import { describe, it, expect } from "vitest";
import { RuleBasedCareEngine, collectSignalCorpus } from "../src";
import type { SourceSignals } from "../src/adapters";
import type { PowoSignals } from "../src/adapters/powo";
import type { InatSignals } from "../src/adapters/inat";
import type { GbifSignals } from "../src/adapters/gbif";

const makePowoSignals = (): SourceSignals<PowoSignals> => ({
  signals: {
    lifeforms: ["Hemiepiphytic vine"],
    habitats: ["humid tropical rainforest understory"],
    biome: ["rainforest"],
    textSnippets: [{ heading: "Habitat", text: "A hemiepiphytic vine in tropical rainforest understory." }]
  },
  context: {
    fetchedAt: "2024-10-12T00:00:00.000Z",
    fromCache: false,
    url: "https://powo.science.kew.org/api/3/taxon/327761-2"
  }
});

const makeInatSignals = (): SourceSignals<InatSignals> => ({
  signals: {
    globalEstablishment: "native",
    establishment: [
      { placeId: 1, placeName: "Mexico", status: "native" },
      { placeId: 2, placeName: "Hawaii", status: "introduced" }
    ],
    seasonality: [
      { month: 3, observationCount: 24 },
      { month: 4, observationCount: 32 },
      { month: 8, observationCount: 12 }
    ],
    wikipediaSummary: "A tropical hemiepiphyte thriving in humid rainforest understories."
  },
  context: {
    fetchedAt: "2024-10-12T00:00:00.000Z",
    fromCache: false,
    url: "https://api.inaturalist.org/v1/taxa/48234"
  }
});

const makeGbifSignals = (): SourceSignals<GbifSignals> => ({
  signals: {
    habitats: [
      { name: "tropical moist forest", count: 120 },
      { name: "disturbed lowland forest", count: 42 }
    ],
    seasonality: [
      { month: 5, observationCount: 64 },
      { month: 6, observationCount: 37 }
    ],
    occurrenceCount: 1012
  },
  context: {
    fetchedAt: "2024-10-12T00:00:00.000Z",
    fromCache: false,
    url: "https://api.gbif.org/v1/occurrence/search?taxonKey=2868241"
  }
});

describe("RuleBasedCareEngine", () => {
  it("maps POWO and iNat signals into a care profile", () => {
    const powo = makePowoSignals();
    const inat = makeInatSignals();
    // ensure corpus collector doesn't throw
    expect(() => collectSignalCorpus({ powo, inat })).not.toThrow();

    const engine = new RuleBasedCareEngine();
    const profile = engine.map({
      target: {
        taxon: { canonicalName: "Monstera deliciosa", powoId: "327761-2", inatId: 48234 }
      },
      signals: { powo, inat },
      generatedAt: "2024-10-12T00:00:00.000Z"
    });

    expect(profile.light?.value).toContain("bright_indirect");
    expect(profile.water?.value).toBe("medium");
    expect(profile.humidity?.value).toBe("high");
    expect(profile.habits?.value).toContain("vine");
    expect(profile.establishment?.global?.value).toBe("native");
    expect(profile.bloom?.default?.value.months).toEqual([4, 3, 8]);
  });

  it("folds GBIF habitats and seasonality into the corpus", () => {
    const powo = makePowoSignals();
    const inat = makeInatSignals();
    const gbif = makeGbifSignals();

    const corpus = collectSignalCorpus({ powo, inat, gbif });
    expect(corpus.habitats.some((value) => value.sourceId === "gbif")).toBe(true);
    expect(corpus.seasonality).toHaveLength(2);

    const engine = new RuleBasedCareEngine();
    const profile = engine.map({
      target: {
        taxon: { canonicalName: "Monstera deliciosa", powoId: "327761-2", inatId: 48234, gbifId: "2868241" }
      },
      signals: { powo, inat, gbif },
      generatedAt: "2024-10-12T00:00:00.000Z"
    });

    expect(profile.bloom?.default?.value.months).toEqual([5, 6, 4, 3, 8]);
    expect(profile.bloom?.default?.evidence?.map((entry) => entry.source.id)).toContain("gbif");
  });
});
