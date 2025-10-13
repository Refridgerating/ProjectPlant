import type { CareProfile, GuidanceBlock, GuidanceContext, ConfidenceLevel, Confidence, Evidence } from "./schema";

/**
 * Context passed to predicates and formatters so they can inspect the profile.
 */
export interface GuidanceContextInput {
  profile: CareProfile;
}

export type GuidancePredicate = (ctx: GuidanceContextInput) => boolean;

export interface GuidanceTextResult {
  text: string;
  confidence?: Confidence;
  evidence?: Evidence[];
}

export type GuidanceFormatter = (ctx: GuidanceContextInput) => string | GuidanceTextResult | undefined;

export interface GuidanceTemplate {
  id: string;
  context: GuidanceContext;
  /**
   * Higher numbers are evaluated first; default priority is 0.
   */
  priority?: number;
  /**
   * When defined, templates are skipped if the overall profile confidence
   * drops below the requested level.
   */
  minimumConfidence?: ConfidenceLevel;
  /**
   * All predicates must pass for the template to render.
   */
  when?: GuidancePredicate[];
  summary: GuidanceFormatter;
  details?: GuidanceFormatter[];
}

export interface GuidanceEngine {
  templates: GuidanceTemplate[];
  render(profile: CareProfile): GuidanceBlock[];
}
