import type { Confidence } from "../schema";

export interface ConfidenceInput {
  weight: number;
  evidenceCount: number;
  /**
   * Structured signals (e.g., POWO lifeform list) can bump the level.
   */
  structuredOverride?: boolean;
}

export const weightToConfidence = (input: ConfidenceInput): Confidence => {
  const { weight, evidenceCount, structuredOverride } = input;
  const normalized = Math.min(1, weight / 2.5);
  let level: Confidence["level"];

  if (structuredOverride && weight >= 0.5) {
    level = "high";
  } else if (weight >= 1.5) {
    level = "high";
  } else if (weight >= 0.9) {
    level = "medium";
  } else if (weight > 0) {
    level = "low";
  } else {
    level = "speculative";
  }

  return {
    level,
    score: Number(normalized.toFixed(2)),
    rationale:
      level === "speculative" && evidenceCount === 0
        ? "No supporting evidence gathered."
        : undefined
  };
};
