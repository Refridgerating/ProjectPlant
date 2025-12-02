import type {
  DormancyType,
  HumidityLevel,
  LightLevel,
  SoilDrainage,
  SoilMoisture,
  SoilPh,
  SoilTexture,
  TemperatureBand,
  ToleranceFlag,
  WaterNeed,
  PlantHabit
} from "../schema";

/**
 * Keyword dictionaries used by the rule-based care engine. They intentionally
 * remain lightweight and easily auditable so future ML pipelines can reference
 * or override individual mappings.
 */

export interface KeywordRule<TValue> {
  pattern: RegExp;
  value: TValue;
  weight: number;
  /**
   * Optional explanation surfaced in evidence notes.
   */
  rationale?: string;
}

export const LIGHT_RULES: KeywordRule<LightLevel>[] = [
  { pattern: /\b(desert|xeric|savanna|full[-\s]?sun|direct\s+sun(light)?|open\s+sun)\b/i, value: "full_sun", weight: 0.9 },
  { pattern: /\b(partial\s+shade|part\s+sun|savanna|dappled\s+light|filtered\s+light|morning\s+sun|afternoon\s+shade)\b/i, value: "partial_sun", weight: 0.6 },
  { pattern: /\b(rainforest|understory|cloud\s?forest|bright\s+indirect|east[-\s]?facing|north[-\s]?light)\b/i, value: "bright_indirect", weight: 0.8 },
  { pattern: /\b(deep\s+shade|forest\s+floor|full\s+shade|heavy\s+shade)\b/i, value: "full_shade", weight: 0.9 }
];

export const WATER_RULES: KeywordRule<WaterNeed>[] = [
  { pattern: /\b(desert|xeric|succulent|cactus|arid|xerophyte)\b/i, value: "very_low", weight: 0.9 },
  { pattern: /\b(dry\s+forest|seasonally\s+dry|well[-\s]?drained|fast[-\s]?draining)\b/i, value: "low", weight: 0.6 },
  { pattern: /\b(rainforest|humid\s+tropics|mesic|moist\s+forest|consistently\s+moist)\b/i, value: "medium", weight: 0.7 },
  { pattern: /\b(swamp|bog|riparian|wetland|marsh|hydric|waterlogged|saturated)\b/i, value: "high", weight: 0.9 },
  { pattern: /\b(aquatic|semi[-\s]?aquatic|standing\s+water|pond)\b/i, value: "aquatic", weight: 1.0 }
];

export const HUMIDITY_RULES: KeywordRule<HumidityLevel>[] = [
  { pattern: /\b(arid|desert|xeric)\b/i, value: "low", weight: 0.8 },
  { pattern: /\b(tropical|rainforest|humid|cloud\s?forest|muggy)\b/i, value: "high", weight: 0.9 },
  { pattern: /\b(temperate|savanna|montane|average\s+indoor)\b/i, value: "medium", weight: 0.5 }
];

export const TEMPERATURE_MIN_RULES: KeywordRule<TemperatureBand>[] = [
  { pattern: /\b(tropical|rainforest|lowland|frost[-\s]?tender)\b/i, value: "above_15c", weight: 0.7 },
  { pattern: /\b(subtropical|warm\s+temperate|mild\s+winter)\b/i, value: "10_to_15c", weight: 0.6 },
  { pattern: /\b(montane|highland|cool\s+temperate)\b/i, value: "5_to_10c", weight: 0.6 },
  { pattern: /\b(alpine|high\s+elevation|frost\s+hardy|cold\s+temperate|hardy\s+to\s+freezing)\b/i, value: "0_to_5c", weight: 0.7 },
  { pattern: /\b(nival|subarctic|boreal)\b/i, value: "minus10_to_0c", weight: 0.8 }
];

export const SOIL_DRAINAGE_RULES: KeywordRule<SoilDrainage>[] = [
  { pattern: /\b(well[-\s]?drained|free[-\s]?draining|sandy|rocky|gritty)\b/i, value: "fast", weight: 0.8 },
  { pattern: /\b(loam|forest\s+floor|humus|garden\s+loam)\b/i, value: "medium", weight: 0.6 },
  { pattern: /\b(clay|heavy\s+soil|slow\s+drainage)\b/i, value: "slow", weight: 0.7 },
  { pattern: /\b(swamp|bog|standing\s+water|marsh|waterlogged)\b/i, value: "standing_water_ok", weight: 0.9 }
];

export const SOIL_MOISTURE_RULES: KeywordRule<SoilMoisture>[] = [
  { pattern: /\b(dry\s+season|xeric|desert|let\s+soil\s+dry)\b/i, value: "dry", weight: 0.8 },
  { pattern: /\b(evenly\s+moist|mesic|rainforest|keep\s+moist)\b/i, value: "evenly_moist", weight: 0.7 },
  { pattern: /\b(wetland|bog|swamp|riparian|aquatic|standing\s+water)\b/i, value: "wet", weight: 0.9 }
];

export const SOIL_TEXTURE_RULES: KeywordRule<SoilTexture>[] = [
  { pattern: /\b(sand|dune|coastal|sandy\s+loam)\b/i, value: "sand", weight: 0.8 },
  { pattern: /\b(loam|humus|forest\s+floor|rich\s+organic)\b/i, value: "loam", weight: 0.6 },
  { pattern: /\b(clay|heavy\s+soil|clay\s+loam)\b/i, value: "clay", weight: 0.7 },
  { pattern: /\b(rocky|gravel|limestone|karst|stony)\b/i, value: "rocky", weight: 0.6 }
];

export const SOIL_PH_RULES: KeywordRule<SoilPh>[] = [
  { pattern: /\b(acidic|acid\s+soil|peat)\b/i, value: "acidic", weight: 0.8 },
  { pattern: /\b(neutral|loam)\b/i, value: "neutral", weight: 0.4 },
  { pattern: /\b(alkaline|limestone|calcareous)\b/i, value: "alkaline", weight: 0.9 }
];

export const TOLERANCE_RULES: KeywordRule<ToleranceFlag>[] = [
  { pattern: /\b(drought\s+tolerant|xeric|succulent|cactus)\b/i, value: "drought", weight: 0.9 },
  { pattern: /\b(shade\s+tolerant|understory|forest\s+floor|deep\s+shade)\b/i, value: "shade", weight: 0.8 },
  { pattern: /\b(coastal|salt\s+spray|mangrove)\b/i, value: "salt", weight: 0.8 },
  { pattern: /\b(wind\s+exposed|coastal)\b/i, value: "wind", weight: 0.6 }
];

export const HABIT_RULES: KeywordRule<PlantHabit>[] = [
  { pattern: /\b(tree|arborescent)\b/i, value: "tree", weight: 0.8 },
  { pattern: /\b(shrub|bush)\b/i, value: "shrub", weight: 0.8 },
  { pattern: /\b(herb|herbaceous)\b/i, value: "herb", weight: 0.7 },
  { pattern: /\b(grass|graminoid|sedge|rush)\b/i, value: "graminoid", weight: 0.9 },
  { pattern: /\b(vine|climber|liana)\b/i, value: "vine", weight: 0.8 },
  { pattern: /\b(epiphyte|epilith|air\s+plant)\b/i, value: "epiphyte", weight: 0.9 },
  { pattern: /\b(bulb|tuber|rhizome|corm)\b/i, value: "geophyte", weight: 0.9 },
  { pattern: /\b(fern|pteridophyte)\b/i, value: "fern", weight: 0.9 },
  { pattern: /\b(succulent)\b/i, value: "succulent", weight: 0.9 },
  { pattern: /\b(cactus|cactaceae)\b/i, value: "cactus", weight: 1.0 }
];

export const DORMANCY_RULES: KeywordRule<DormancyType>[] = [
  { pattern: /\b(winter\s+dormant|deciduous)\b/i, value: "winter", weight: 0.7 },
  { pattern: /\b(summer\s+dormant|estival)\b/i, value: "summer", weight: 0.7 },
  { pattern: /\bdormant\b/i, value: "irregular", weight: 0.3 }
];
