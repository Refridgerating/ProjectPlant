import {
  type GuidanceEngine,
  type GuidanceTemplate,
  type GuidanceContextInput,
  type GuidanceTextResult
} from "../guidance";
import type { CareProfile, Confidence, ConfidenceLevel, Evidence, GuidanceBlock } from "../schema";
import {
  buildIndoorRecommendations,
  buildOutdoorRecommendations,
  joinList,
  type ScenarioRecommendations
} from "./scenario-transforms";

const CONFIDENCE_ORDER: ConfidenceLevel[] = ["speculative", "low", "medium", "high"];

interface RenderContext extends GuidanceContextInput {
  indoor: ScenarioRecommendations;
  outdoor: ScenarioRecommendations;
}

const normalizeResult = (
  result: string | GuidanceTextResult | undefined
): GuidanceTextResult | undefined => {
  if (!result) return undefined;
  if (typeof result === "string") {
    return { text: result };
  }
  return result;
};

const pickConfidence = (...items: (Confidence | undefined)[]): Confidence | undefined => {
  return items
    .filter((item): item is Confidence => Boolean(item))
    .sort((a, b) => CONFIDENCE_ORDER.indexOf(b.level) - CONFIDENCE_ORDER.indexOf(a.level))[0];
};

const mergeEvidence = (...lists: (Evidence[] | undefined)[]): Evidence[] | undefined => {
  const merged = lists.flatMap((list) => list ?? []);
  return merged.length > 0 ? merged : undefined;
};

export class TemplateGuidanceEngine implements GuidanceEngine {
  constructor(public templates: GuidanceTemplate[]) {}

  render(profile: CareProfile): GuidanceBlock[] {
    const indoor = buildIndoorRecommendations(profile);
    const outdoor = buildOutdoorRecommendations(profile);
    const context: RenderContext = { profile, indoor, outdoor };

    const sorted = [...this.templates].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    const blocks: GuidanceBlock[] = [];

    for (const template of sorted) {
      if (template.when && !template.when.every((predicate) => predicate(context))) {
        continue;
      }

      const summaryResult = normalizeResult(template.summary(context));
      if (!summaryResult) continue;

      if (template.minimumConfidence && summaryResult.confidence) {
        const meetsMinimum =
          CONFIDENCE_ORDER.indexOf(summaryResult.confidence.level) >=
          CONFIDENCE_ORDER.indexOf(template.minimumConfidence);
        if (!meetsMinimum) continue;
      } else if (template.minimumConfidence && !summaryResult.confidence) {
        continue;
      }

      const detailResults: GuidanceTextResult[] =
        template.details
          ?.map((formatter) => normalizeResult(formatter(context)))
          .filter((detail): detail is GuidanceTextResult => Boolean(detail)) ?? [];

      const details = detailResults.map((detail) => detail.text);
      const confidence =
        summaryResult.confidence ?? pickConfidence(...detailResults.map((detail) => detail.confidence));

      const evidence = mergeEvidence(summaryResult.evidence, ...detailResults.map((detail) => detail.evidence));

      blocks.push({
        id: template.id,
        context: template.context,
        summary: summaryResult.text,
        details: details.length > 0 ? details : undefined,
        confidence,
        evidence
      });
    }

    return blocks;
  }
}

// ---------------------------------------------------------------------------
// Default template helpers
// ---------------------------------------------------------------------------

const LIGHT_LABELS: Record<string, string> = {
  full_sun: "full sun",
  partial_sun: "partial sun",
  bright_indirect: "bright indirect light",
  full_shade: "full shade"
};

const WATER_LABELS: Record<string, string> = {
  very_low: "very infrequent watering",
  low: "light watering",
  medium: "moderate moisture",
  high: "consistently moist soil",
  aquatic: "standing water"
};

const HUMIDITY_LABELS: Record<string, string> = {
  low: "low humidity",
  medium: "average room humidity",
  high: "high humidity"
};

const describeLightGeneral = (profile: CareProfile): GuidanceTextResult | undefined => {
  if (!profile.light || profile.light.value.length === 0) return undefined;
  const labels = profile.light.value.map((value) => LIGHT_LABELS[value]);
  const text = `Prefers ${joinList(labels)}.`;
  return {
    text,
    confidence: profile.light.confidence,
    evidence: profile.light.evidence
  };
};

const describeWaterGeneral = (profile: CareProfile): GuidanceTextResult | undefined => {
  if (!profile.water) return undefined;
  const text = `Keep soil at ${WATER_LABELS[profile.water.value]}.`;
  return {
    text,
    confidence: profile.water.confidence,
    evidence: profile.water.evidence
  };
};

const describeHumidityGeneral = (profile: CareProfile): GuidanceTextResult | undefined => {
  if (!profile.humidity) return undefined;
  const text = `Thrives in ${HUMIDITY_LABELS[profile.humidity.value]}.`;
  return {
    text,
    confidence: profile.humidity.confidence,
    evidence: profile.humidity.evidence
  };
};

const describeSoilGeneral = (profile: CareProfile): GuidanceTextResult | undefined => {
  const soilPieces: string[] = [];
  const evidence: Evidence[] = [];
  const confidences: Confidence[] = [];

  if (profile.soil?.drainage) {
    soilPieces.push(profile.soil.drainage.value.replace(/_/g, " ") + " drainage");
    evidence.push(...(profile.soil.drainage.evidence ?? []));
    if (profile.soil.drainage.confidence) confidences.push(profile.soil.drainage.confidence);
  }
  if (profile.soil?.texture && profile.soil.texture.value.length > 0) {
    soilPieces.push(`${joinList(profile.soil.texture.value.map((text) => text.replace(/_/g, " ")))} texture`);
    evidence.push(...(profile.soil.texture.evidence ?? []));
    if (profile.soil.texture.confidence) confidences.push(profile.soil.texture.confidence);
  }
  if (profile.soil?.ph && profile.soil.ph.value.length > 0) {
    soilPieces.push(`${profile.soil.ph.value[0]} pH`);
    evidence.push(...(profile.soil.ph.evidence ?? []));
    if (profile.soil.ph.confidence) confidences.push(profile.soil.ph.confidence);
  }

  if (soilPieces.length === 0) return undefined;

  return {
    text: `Soil preference: ${joinList(soilPieces)}.`,
    confidence: pickConfidence(...confidences),
    evidence: evidence.length > 0 ? evidence : undefined
  };
};

const describeTemperatureGeneral = (profile: CareProfile): GuidanceTextResult | undefined => {
  const minimum = profile.temperature?.minimum;
  if (!minimum) return undefined;

  return {
    text: `Minimum temperature target: ${minimum.value.replace(/_/g, " ")}.`,
    confidence: minimum.confidence,
    evidence: minimum.evidence
  };
};

// ---------------------------------------------------------------------------
// Default templates
// ---------------------------------------------------------------------------

export const DEFAULT_GUIDANCE_TEMPLATES: GuidanceTemplate[] = [
  {
    id: "general_overview",
    context: "general",
    priority: 100,
    summary: (ctx) => {
      const { profile } = ctx as RenderContext;
      const parts: GuidanceTextResult[] = [];
      const light = describeLightGeneral(profile);
      if (light) parts.push(light);
      const water = describeWaterGeneral(profile);
      if (water) parts.push(water);
      const humidity = describeHumidityGeneral(profile);
      if (humidity) parts.push(humidity);

      if (parts.length === 0) return undefined;

      const text = parts.map((part) => part.text).join(" ");
      return {
        text,
        confidence: pickConfidence(...parts.map((part) => part.confidence)),
        evidence: mergeEvidence(...parts.map((part) => part.evidence))
      };
    }
  },
  {
    id: "general_soil",
    context: "general",
    priority: 90,
    summary: (ctx) => {
      const { profile } = ctx as RenderContext;
      return describeSoilGeneral(profile);
    }
  },
  {
    id: "general_temperature",
    context: "general",
    priority: 80,
    summary: (ctx) => {
      const { profile } = ctx as RenderContext;
      return describeTemperatureGeneral(profile);
    }
  },
  {
    id: "indoor_light",
    context: "indoor",
    priority: 100,
    summary: (ctx) => {
      const { indoor } = ctx as RenderContext;
      if (!indoor.light) return undefined;
      return {
        text: indoor.light.summary,
        confidence: indoor.light.confidence,
        evidence: indoor.light.evidence
      };
    },
    details: [
      (ctx) => {
        const { indoor } = ctx as RenderContext;
        if (!indoor.light?.details || indoor.light.details.length === 0) return undefined;
        return indoor.light.details[0];
      }
    ]
  },
  {
    id: "indoor_water_humidity",
    context: "indoor",
    priority: 90,
    summary: (ctx) => {
      const { indoor } = ctx as RenderContext;
      if (!indoor.water) return undefined;
      return {
        text: indoor.water.summary,
        confidence: indoor.water.confidence,
        evidence: indoor.water.evidence
      };
    },
    details: [
      (ctx) => {
        const { indoor } = ctx as RenderContext;
        return indoor.water?.details?.[0];
      },
      (ctx) => {
        const { indoor } = ctx as RenderContext;
        return indoor.humidity
          ? {
              text: indoor.humidity.summary,
              confidence: indoor.humidity.confidence,
              evidence: indoor.humidity.evidence
            }
          : undefined;
      },
      (ctx) => {
        const { indoor } = ctx as RenderContext;
        return indoor.humidity?.details?.[0];
      }
    ]
  },
  {
    id: "indoor_temperature",
    context: "indoor",
    priority: 80,
    summary: (ctx) => {
      const { indoor } = ctx as RenderContext;
      return indoor.temperature
        ? {
            text: indoor.temperature.summary,
            confidence: indoor.temperature.confidence,
            evidence: indoor.temperature.evidence
          }
        : undefined;
    }
  },
  {
    id: "indoor_soil",
    context: "indoor",
    priority: 70,
    summary: (ctx) => {
      const { indoor } = ctx as RenderContext;
      return indoor.soil
        ? {
            text: indoor.soil.summary,
            confidence: indoor.soil.confidence,
            evidence: indoor.soil.evidence
          }
        : undefined;
    }
  },
  {
    id: "outdoor_light",
    context: "outdoor",
    priority: 100,
    summary: (ctx) => {
      const { outdoor } = ctx as RenderContext;
      return outdoor.light
        ? {
            text: outdoor.light.summary,
            confidence: outdoor.light.confidence,
            evidence: outdoor.light.evidence
          }
        : undefined;
    },
    details: [
      (ctx) => {
        const { outdoor } = ctx as RenderContext;
        return outdoor.light?.details?.[0];
      }
    ]
  },
  {
    id: "outdoor_water_soil",
    context: "outdoor",
    priority: 90,
    summary: (ctx) => {
      const { outdoor } = ctx as RenderContext;
      return outdoor.water
        ? {
            text: outdoor.water.summary,
            confidence: outdoor.water.confidence,
            evidence: outdoor.water.evidence
          }
        : undefined;
    },
    details: [
      (ctx) => {
        const { outdoor } = ctx as RenderContext;
        return outdoor.water?.details?.[0];
      },
      (ctx) => {
        const { outdoor } = ctx as RenderContext;
        return outdoor.soil
          ? {
              text: outdoor.soil.summary,
              confidence: outdoor.soil.confidence,
              evidence: outdoor.soil.evidence
            }
          : undefined;
      },
      (ctx) => {
        const { outdoor } = ctx as RenderContext;
        return outdoor.soil?.details?.[0];
      }
    ]
  },
  {
    id: "outdoor_temperature",
    context: "outdoor",
    priority: 80,
    summary: (ctx) => {
      const { outdoor } = ctx as RenderContext;
      return outdoor.temperature
        ? {
            text: outdoor.temperature.summary,
            confidence: outdoor.temperature.confidence,
            evidence: outdoor.temperature.evidence
          }
        : undefined;
    }
  },
  {
    id: "outdoor_bonus",
    context: "outdoor",
    priority: 70,
    summary: (ctx) => {
      const { outdoor } = ctx as RenderContext;
      if (!outdoor.bonus || outdoor.bonus.length === 0) return undefined;
      const first = outdoor.bonus[0];
      return {
        text: first.summary,
        confidence: first.confidence,
        evidence: first.evidence
      };
    },
    details: [
      (ctx) => {
        const { outdoor } = ctx as RenderContext;
        if (!outdoor.bonus || outdoor.bonus.length < 2) return undefined;
        return {
          text: outdoor.bonus[1].summary,
          confidence: outdoor.bonus[1].confidence,
          evidence: outdoor.bonus[1].evidence
        };
      }
    ]
  }
];

export const createDefaultGuidanceEngine = (): TemplateGuidanceEngine =>
  new TemplateGuidanceEngine(DEFAULT_GUIDANCE_TEMPLATES);
