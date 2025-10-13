import { useMemo } from "react";
import type { CareProfile, GuidanceBlock } from "@projectplant/care-engine";
import { createDefaultGuidanceEngine } from "@projectplant/care-engine";

const guidanceEngine = createDefaultGuidanceEngine();

export interface CareGuidanceResult {
  general: GuidanceBlock[];
  indoor: GuidanceBlock[];
  outdoor: GuidanceBlock[];
}

export function useCareGuidance(profile: CareProfile | null | undefined): CareGuidanceResult {
  return useMemo(() => {
    if (!profile) {
      return { general: [], indoor: [], outdoor: [] };
    }
    const blocks = guidanceEngine.render(profile);
    return {
      general: blocks.filter((block) => block.context === "general"),
      indoor: blocks.filter((block) => block.context === "indoor"),
      outdoor: blocks.filter((block) => block.context === "outdoor")
    };
  }, [profile]);
}
