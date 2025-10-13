import { describe, it, expect } from "vitest";
import { RuleBasedCareEngine, collectSignalCorpus } from "../src";
import type { SourceSignals } from "../src/adapters";
import type { PowoSignals } from "../src/adapters/powo";
import type { InatSignals } from "../src/adapters/inat";

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
});
