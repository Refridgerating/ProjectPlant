import type { CareProfile } from "./schema";

/**
 * Example profile used for doc tests and downstream smoke checks.
 */
export const EXAMPLE_MONSTERA_PROFILE: CareProfile = {
  taxon: {
    canonicalName: "Monstera deliciosa",
    powoId: "urn:lsid:ipni.org:names:327761-2",
    inatId: 48234
  },
  metadata: {
    schemaVersion: "2024-10-12",
    inferenceVersion: "rule-based-v1",
    generatedAt: "2024-10-12T00:00:00.000Z"
  },
  light: {
    value: ["bright_indirect"],
    confidence: { level: "high", score: 0.9 },
    evidence: [
      {
        source: {
          id: "powo",
          name: "Plants of the World Online",
          url: "https://powo.science.kew.org/taxon/327761-2"
        },
        signal: "habitat: rainforest understory"
      }
    ]
  },
  water: {
    value: "medium",
    confidence: { level: "medium", score: 0.6, rationale: "Derived from habitat keywords" },
    evidence: [
      {
        source: { id: "powo" },
        signal: "humid forest",
        weight: 0.5
      },
      {
        source: { id: "inat", name: "iNaturalist" },
        signal: "observations in high humidity locales",
        weight: 0.5
      }
    ]
  },
  humidity: {
    value: "high",
    confidence: { level: "medium" },
    evidence: [{ source: { id: "powo" }, signal: "tropical rainforest" }]
  },
  temperature: {
    minimum: {
      value: "10_to_15c",
      confidence: { level: "medium" },
      evidence: [{ source: { id: "derived" }, signal: "tropical tolerance heuristic" }]
    },
    frostTolerance: {
      value: false,
      confidence: { level: "high" },
      evidence: [{ source: { id: "powo" }, signal: "no frost exposure in range" }]
    }
  },
  soil: {
    drainage: {
      value: "medium",
      confidence: { level: "medium" },
      evidence: [{ source: { id: "derived" }, signal: "epiphyte/aerial root mix" }]
    },
    texture: {
      value: ["loam", "rocky"],
      confidence: { level: "low", rationale: "Placeholder inference" },
      evidence: []
    }
  },
  habits: {
    value: ["vine", "epiphyte"],
    confidence: { level: "high" },
    evidence: [{ source: { id: "powo" }, signal: "habit: hemiepiphytic vine" }]
  },
  tolerances: {
    value: ["shade"],
    confidence: { level: "medium" },
    evidence: [{ source: { id: "powo" }, signal: "grows in forest understory" }]
  }
};
