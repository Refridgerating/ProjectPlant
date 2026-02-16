import { describe, it, expect } from "vitest";
import { RuleBasedCareEngine } from "../src/index.js";
import { assertExpectedFields, loadGoldSamples, loadSignalsForSample } from "./helpers/gold.js";

const FIXED_DATE = "2024-01-01T00:00:00.000Z";

describe("Gold regression samples", () => {
  it("loads fixture file", async () => {
    const samples = await loadGoldSamples();
    expect(samples.length).toBeGreaterThan(0);
  });

  it("validates expected fields for recorded samples", async () => {
    const samples = await loadGoldSamples();
    const engine = new RuleBasedCareEngine();

    for (const sample of samples) {
      const bundle = await loadSignalsForSample(sample);
      if (!bundle) {
        // eslint-disable-next-line no-console
        console.warn(
          `Skipping ${sample.id}: no raw signals found. Add raw API payloads under test/fixtures/raw/${sample.id}/`
        );
        continue;
      }

      const profile = engine.map({
        target: sample.target,
        signals: bundle,
        generatedAt: FIXED_DATE
      });

      assertExpectedFields(profile, sample.expected, expect);
    }
  });
});
