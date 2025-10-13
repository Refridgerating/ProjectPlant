/**
 * Core schema definitions for derived plant care data used across ProjectPlant.
 * The focus is on normalized categorical fields with per-attribute provenance
 * so rule-based and future ML pipelines can share a single contract.
 */

export const LIGHT_LEVELS = ["full_sun", "partial_sun", "bright_indirect", "full_shade"] as const;
export type LightLevel = typeof LIGHT_LEVELS[number];

export const WATER_NEEDS = ["very_low", "low", "medium", "high", "aquatic"] as const;
export type WaterNeed = typeof WATER_NEEDS[number];

export const HUMIDITY_LEVELS = ["low", "medium", "high"] as const;
export type HumidityLevel = typeof HUMIDITY_LEVELS[number];

export const TEMPERATURE_BANDS = [
  "above_15c",
  "10_to_15c",
  "5_to_10c",
  "0_to_5c",
  "minus10_to_0c",
  "below_minus10c"
] as const;
export type TemperatureBand = typeof TEMPERATURE_BANDS[number];

export const SOIL_DRAINAGE = ["fast", "medium", "slow", "standing_water_ok"] as const;
export type SoilDrainage = typeof SOIL_DRAINAGE[number];

export const SOIL_MOISTURE = ["dry", "evenly_moist", "wet"] as const;
export type SoilMoisture = typeof SOIL_MOISTURE[number];

export const SOIL_TEXTURES = ["sand", "loam", "clay", "rocky"] as const;
export type SoilTexture = typeof SOIL_TEXTURES[number];

export const SOIL_PH = ["acidic", "neutral", "alkaline"] as const;
export type SoilPh = typeof SOIL_PH[number];

export const PLANT_HABITS = [
  "tree",
  "shrub",
  "herb",
  "graminoid",
  "vine",
  "epiphyte",
  "geophyte",
  "fern",
  "succulent",
  "cactus"
] as const;
export type PlantHabit = typeof PLANT_HABITS[number];

export const DORMANCY_TYPES = ["none", "winter", "summer", "irregular"] as const;
export type DormancyType = typeof DORMANCY_TYPES[number];

export const TOLERANCE_FLAGS = ["drought", "shade", "salt", "wind"] as const;
export type ToleranceFlag = typeof TOLERANCE_FLAGS[number];

export const ESTABLISHMENT_STATUSES = ["native", "introduced", "invasive", "uncertain"] as const;
export type EstablishmentStatus = typeof ESTABLISHMENT_STATUSES[number];

export const HEMISPHERES = ["global", "northern", "southern", "equatorial"] as const;
export type Hemisphere = typeof HEMISPHERES[number];

export type MonthNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export const CONFIDENCE_LEVELS = ["speculative", "low", "medium", "high"] as const;
export type ConfidenceLevel = typeof CONFIDENCE_LEVELS[number];

export interface Confidence {
  /**
   * Normalized qualitative bucket that downstream UIs can map directly.
   */
  level: ConfidenceLevel;
  /**
   * Optional numeric score in [0,1] for ML-friendly ranking.
   */
  score?: number;
  /**
   * Human-readable justification when the level alone is insufficient.
   */
  rationale?: string;
}

export interface EvidenceSource {
  /**
   * Stable identifier such as "powo", "inaturalist", or "wikipedia".
   */
  id: string;
  /**
   * Display name for the source (e.g., "Plants of the World Online").
   */
  name?: string;
  /**
   * Direct link to the specific page or API response.
   */
  url?: string;
  /**
   * ISO-8601 timestamp for traceability.
   */
  retrievedAt?: string;
}

export interface Evidence {
  /**
   * Pointer to the upstream source.
   */
  source: EvidenceSource;
  /**
   * Short description of the signal that influenced the value.
   */
  signal?: string;
  /**
   * Optional weight (0..1) to resolve conflicting evidence.
   */
  weight?: number;
  /**
   * Additional notes that help reviewers audit the inference.
   */
  notes?: string;
}

export interface CareValue<TValue> {
  value: TValue;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface NumericRange {
  min?: number;
  max?: number;
  /**
   * Unit in lower-case singular form (e.g., "c", "cm", "m").
   */
  unit: string;
}

export interface ElevationRange {
  minMeters?: number;
  maxMeters?: number;
}

export interface SizeRange {
  heightCm?: NumericRange;
  spreadCm?: NumericRange;
}

export interface SeasonalWindow {
  months: MonthNumber[];
  hemisphere?: Hemisphere;
  placeId?: string | number;
  placeName?: string;
}

export interface RegionalSeasonality {
  context: "hemisphere" | "place";
  window: CareValue<SeasonalWindow>;
}

export interface TemperatureProfile {
  minimum?: CareValue<TemperatureBand>;
  optimum?: CareValue<NumericRange>;
  frostTolerance?: CareValue<boolean>;
}

export interface SoilProfile {
  drainage?: CareValue<SoilDrainage>;
  moisture?: CareValue<SoilMoisture>;
  texture?: CareValue<SoilTexture[]>;
  ph?: CareValue<SoilPh[]>;
  amendments?: CareValue<string[]>;
}

export interface DormancyProfile {
  type?: CareValue<DormancyType>;
  dormantMonths?: CareValue<MonthNumber[]>;
  isGeophyte?: CareValue<boolean>;
}

export interface BloomProfile {
  default?: CareValue<SeasonalWindow>;
  regional?: RegionalSeasonality[];
}

export interface EstablishmentRecord {
  placeId?: string | number;
  placeName?: string;
  status: EstablishmentStatus;
  confidence: Confidence;
  evidence: Evidence[];
}

export interface EstablishmentProfile {
  global?: CareValue<EstablishmentStatus>;
  regional?: EstablishmentRecord[];
}

export interface TaxonReference {
  canonicalName: string;
  powoId?: string;
  ipniId?: string;
  inatId?: number;
  gbifId?: string;
  otherIds?: Record<string, string | number>;
}

export interface GuidanceBlock {
  id: string;
  context: GuidanceContext;
  summary: string;
  details?: string[];
  confidence?: Confidence;
  evidence?: Evidence[];
}

export const GUIDANCE_CONTEXTS = ["general", "indoor", "outdoor"] as const;
export type GuidanceContext = typeof GUIDANCE_CONTEXTS[number];

export interface CareProfileMetadata {
  schemaVersion: string;
  inferenceVersion: string;
  generatedAt: string;
  locale?: string;
}

export interface CareProfile {
  taxon: TaxonReference;
  metadata: CareProfileMetadata;
  light?: CareValue<LightLevel[]>;
  water?: CareValue<WaterNeed>;
  humidity?: CareValue<HumidityLevel>;
  temperature?: TemperatureProfile;
  soil?: SoilProfile;
  habits?: CareValue<PlantHabit[]>;
  dormancy?: DormancyProfile;
  bloom?: BloomProfile;
  tolerances?: CareValue<ToleranceFlag[]>;
  establishment?: EstablishmentProfile;
  elevation?: CareValue<ElevationRange>;
  size?: CareValue<SizeRange>;
  notes?: GuidanceBlock[];
}
