# ProjectPlant Care Engine

TypeScript schema, enums, and helper interfaces for normalizing plant care
signals (POWO, iNaturalist, etc.) into a single contract. The types are designed
for both rule-based NLP pipelines today and ML-driven inference in the future.

## Quick start

```ts
import type { CareProfile, LIGHT_LEVELS } from "@projectplant/care-engine";

const profile: CareProfile = {
  taxon: {
    canonicalName: "Monstera deliciosa",
    powoId: "urn:lsid:ipni.org:names:327761-2",
    inatId: 48234
  },
  metadata: {
    schemaVersion: "2024-10-12",
    inferenceVersion: "powo-inat-rule-v1",
    generatedAt: new Date().toISOString()
  },
  light: {
    value: [LIGHT_LEVELS[2]],
    confidence: { level: "high", score: 0.9 },
    evidence: [
      {
        source: {
          id: "powo",
          name: "Plants of the World Online",
          url: "https://powo.science.kew.org/taxon/48234"
        },
        signal: "habitat: rainforest understory"
      }
    ]
  }
};
```

See `src/schema.ts` for the full set of enums and structures (light, water,
humidity, temperature, soil, bloom, establishment, etc.). Guidance templates
can be wired using the interfaces in `src/guidance.ts`.

## Adapters & caching

- `src/adapters/powo.ts` and `src/adapters/inat.ts` provide fetch/parse
  scaffolding for POWO and iNaturalist (with pluggable caching and optional
  seasonality pulls).
- `src/cache/` exposes `FileCache` and `MemoryCache` helpers implementing the
  shared `CacheProvider` contract so pipelines can persist raw payloads for
  auditing or offline runs.
- `src/engine/rule-engine.ts` houses the rule-based mapper that turns adapter
  signals into normalized `CareProfile` objects using keyword heuristics and
  structured evidence weighting.
- `src/engine/scenario-transforms.ts` provides indoor and outdoor-specific
  heuristics for translating normalized care fields into practical advice.
- `src/engine/guidance-engine.ts` ships a template-based renderer that emits
  `GuidanceBlock`s for general, indoor, and outdoor contexts.

```ts
import {
  createFileCache,
  createPowoAdapter,
  createInatAdapter,
  RuleBasedCareEngine,
  createDefaultGuidanceEngine
} from "@projectplant/care-engine";

const cache = createFileCache({ rootDir: ".projectplant/cache", namespace: "sources" });
const powo = createPowoAdapter({ cache });
const inat = createInatAdapter({ cache });

const target = { taxon: { canonicalName: "Monstera deliciosa", powoId: "48234", inatId: 48234 } };

const powoSignals = await powo.parse(await powo.fetch(target));
const inatSignals = await inat.parse(await inat.fetch(target));

const engine = new RuleBasedCareEngine();
const careProfile = engine.map({
  target,
  signals: { powo: powoSignals, inat: inatSignals }
});

console.log(careProfile.light?.value); // → ["bright_indirect"]

const guidanceEngine = createDefaultGuidanceEngine();
const guidanceBlocks = guidanceEngine.render(careProfile);

const indoorTips = guidanceBlocks.filter((block) => block.context === "indoor");
console.log(indoorTips[0]?.summary); // e.g. "Keep it a few feet back from a bright window..."
```

## Batch building & storage

- `src/batch/builder.ts` contains `CareProfileBatchBuilder` for running adapters,
  mapping profiles, and persisting results in one pass.
- `src/storage/json-file-storage.ts` writes profiles to disk (one JSON per
  taxon); `src/storage/memory-storage.ts` is handy for tests.

```ts
import {
  CareProfileBatchBuilder,
  createJsonFileStorage,
  RuleBasedCareEngine,
  createPowoAdapter,
  createInatAdapter
} from "@projectplant/care-engine";

const storage = createJsonFileStorage({ rootDir: ".projectplant/care-profiles" });
const engine = new RuleBasedCareEngine();
const builder = new CareProfileBatchBuilder({
  adapters: { powo: createPowoAdapter(), inat: createInatAdapter() },
  careEngine: engine,
  storage,
  runId: "powo-inat-rule-v1"
});

await builder.run([
  { id: "327761-2", taxon: { canonicalName: "Monstera deliciosa", powoId: "327761-2", inatId: 48234 } }
]);
```
