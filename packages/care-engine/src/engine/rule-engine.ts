import {
  LIGHT_RULES,
  WATER_RULES,
  HUMIDITY_RULES,
  TEMPERATURE_MIN_RULES,
  SOIL_DRAINAGE_RULES,
  SOIL_MOISTURE_RULES,
  SOIL_TEXTURE_RULES,
  SOIL_PH_RULES,
  TOLERANCE_RULES,
  HABIT_RULES,
  DORMANCY_RULES
} from "../rules/keyword-dictionary";
import {
  aggregateMatches,
  matchKeywordRules,
  type KeywordMatch,
  type CorpusToken
} from "../rules/apply-keywords";
import type { KeywordRule } from "../rules/keyword-dictionary";
import { collectSignalCorpus, type AdapterSignalBundle, type AttributedValue } from "./signal-collector.js";
import { weightToConfidence } from "./confidence.js";
import {
  type CareProfile,
  type CareValue,
  type Confidence,
  type DormancyProfile,
  type Evidence,
  type EstablishmentStatus,
  type LightLevel,
  type MonthNumber,
  type PlantHabit,
  type SoilDrainage,
  type SoilMoisture,
  type SoilPh,
  type SoilTexture,
  type TemperatureBand,
  type ToleranceFlag,
  type WaterNeed
} from "../schema";
import type { SourceTarget } from "../adapters/types";

const SOURCE_NAMES: Record<string, string> = {
  powo: "Plants of the World Online",
  inat: "iNaturalist",
  gbif: "Global Biodiversity Information Facility",
  wikipedia: "Wikipedia (via iNaturalist)",
  derived: "ProjectPlant Rule Engine"
};

const SOURCE_WEIGHTS: Record<string, number> = {
  powo: 1.3,
  gbif: 1.1,
  inat: 0.9,
  wikipedia: 0.6,
  derived: 1
};

export interface RuleEngineOptions {
  schemaVersion?: string;
  inferenceVersion?: string;
  locale?: string;
  /**
   * Minimum aggregated weight required to emit a value; below this the field is undefined.
   */
  minMatchWeight?: number;
}

export interface RuleEngineInput {
  target: SourceTarget;
  signals: AdapterSignalBundle;
  generatedAt?: string;
}

export class RuleBasedCareEngine {
  private readonly schemaVersion: string;
  private readonly inferenceVersion: string;
  private readonly locale?: string;
  private readonly minMatchWeight: number;

  constructor(options: RuleEngineOptions = {}) {
    this.schemaVersion = options.schemaVersion ?? "2024-10-12";
    this.inferenceVersion = options.inferenceVersion ?? "rule-based-v1";
    this.locale = options.locale;
    this.minMatchWeight = options.minMatchWeight ?? 0.8;
  }

  map(input: RuleEngineInput): CareProfile {
    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const corpus = collectSignalCorpus(input.signals);
    const tokens = this.buildTokens(corpus);

    const light = this.buildMultiValue<LightLevel>({
      field: "light",
      tokens,
      rules: LIGHT_RULES,
      limit: 2
    });

    const water = this.buildSingleValue<WaterNeed>({
      field: "water",
      tokens,
      rules: WATER_RULES
    });

    const humidity = this.buildSingleValue({
      field: "humidity",
      tokens,
      rules: HUMIDITY_RULES
    });

    const temperatureMin = this.buildSingleValue<TemperatureBand>({
      field: "temperature.minimum",
      tokens,
      rules: TEMPERATURE_MIN_RULES
    });

    const soilDrainage = this.buildSingleValue<SoilDrainage>({
      field: "soil.drainage",
      tokens,
      rules: SOIL_DRAINAGE_RULES
    });

    const soilMoisture = this.buildSingleValue<SoilMoisture>({
      field: "soil.moisture",
      tokens,
      rules: SOIL_MOISTURE_RULES
    });

    const soilTexture = this.buildMultiValue<SoilTexture>({
      field: "soil.texture",
      tokens,
      rules: SOIL_TEXTURE_RULES,
      limit: 3
    });

    const soilPh = this.buildMultiValue<SoilPh>({
      field: "soil.ph",
      tokens,
      rules: SOIL_PH_RULES,
      limit: 2
    });

    const tolerances = this.buildMultiValue<ToleranceFlag>({
      field: "tolerances",
      tokens,
      rules: TOLERANCE_RULES,
      limit: 3
    });

    const habits = this.buildMultiValue<PlantHabit>({
      field: "habits",
      tokens,
      rules: HABIT_RULES,
      limit: 3
    });

    const dormancyType = this.buildSingleValue({
      field: "dormancy.type",
      tokens,
      rules: DORMANCY_RULES
    });

    const dormancy: DormancyProfile | undefined = dormancyType
      ? {
          type: dormancyType
        }
      : undefined;

    const temperature = this.composeTemperature(temperatureMin);
    const soil = this.composeSoil({ drainage: soilDrainage, moisture: soilMoisture, texture: soilTexture, ph: soilPh });

    const bloom = this.composeBloom(corpus);
    const establishment = this.composeEstablishment(corpus);
    const elevation = this.composeElevation(corpus);

    return {
      taxon: input.target.taxon,
      metadata: {
        schemaVersion: this.schemaVersion,
        inferenceVersion: this.inferenceVersion,
        generatedAt,
        locale: this.locale
      },
      light,
      water,
      humidity,
      temperature,
      soil,
      habits,
      dormancy,
      bloom,
      tolerances,
      establishment,
      elevation
    };
  }

  private buildTokens(corpus: ReturnType<typeof collectSignalCorpus>): CorpusToken[] {
    const tokens: CorpusToken[] = [];
    tokens.push(...corpus.texts);
    const valueToToken = (value: AttributedValue): CorpusToken => ({
      text: value.value,
      sourceId: value.sourceId,
      url: value.url,
      field: value.field,
      structured: value.structured
    });
    for (const list of [corpus.habitats, corpus.biomes, corpus.lifeforms]) {
      tokens.push(...list.map(valueToToken));
    }
    return tokens;
  }

  private buildSingleValue<T>({
    field,
    tokens,
    rules
  }: {
    field: string;
    tokens: CorpusToken[];
    rules: readonly KeywordRule<T>[];
  }): CareValue<T> | undefined {
    const matches = matchKeywordRules(tokens, rules, { sourceWeights: SOURCE_WEIGHTS });
    return this.buildCareValueFromMatches<T>({
      matches,
      field,
      limit: 1,
      minWeight: this.minMatchWeight
    }) as CareValue<T> | undefined;
  }

  private buildMultiValue<T>({
    field,
    tokens,
    rules,
    limit
  }: {
    field: string;
    tokens: CorpusToken[];
    rules: readonly KeywordRule<T>[];
    limit: number;
  }): CareValue<T[]> | undefined {
    const matches = matchKeywordRules(tokens, rules, { sourceWeights: SOURCE_WEIGHTS });
    return this.buildCareValueFromMatches<T>({
      matches,
      field,
      limit,
      minWeight: this.minMatchWeight
    }) as CareValue<T[]> | undefined;
  }

  private buildCareValueFromMatches<T>({
    matches,
    field,
    limit,
    minWeight,
    minEvidenceCount
  }: {
    matches: KeywordMatch<T>[];
    field: string;
    limit: number;
    minWeight?: number;
    minEvidenceCount?: number;
  }): CareValue<T | T[]> | undefined {
    if (matches.length === 0) {
      return undefined;
    }

    const aggregated = aggregateMatches(matches);
    const ranked = Array.from(aggregated.entries()).sort((a, b) => b[1].weight - a[1].weight);
    const selected = ranked.slice(0, limit);

    const evidence = selected.flatMap(([value, entry]) =>
      entry.examples.map((example) => this.toEvidence(example, field, value))
    );

    const topWeight = selected[0]?.[1].weight ?? 0;
    const minimumWeight = minWeight ?? 0;
    const minimumEvidence = minEvidenceCount ?? 1;

    if (topWeight < minimumWeight || evidence.length < minimumEvidence) {
      return undefined;
    }

    const confidence = weightToConfidence({
      weight: topWeight,
      evidenceCount: evidence.length,
      structuredOverride: selected[0][1].examples.some((example) => example.token.structured)
    });

    const value =
      limit === 1 ? (selected[0][0] as T) : (selected.map(([value]) => value) as T[]);

    return { value, confidence, evidence };
  }

  private composeTemperature(
    minimum: CareValue<TemperatureBand> | undefined
  ): CareProfile["temperature"] | undefined {
    if (!minimum) return undefined;

    const frostTolerance = this.deriveFrostTolerance(minimum);

    return {
      minimum,
      frostTolerance
    };
  }

  private deriveFrostTolerance(
    minimum: CareValue<TemperatureBand>
  ): CareValue<boolean> | undefined {
    const frostFriendlyBands: TemperatureBand[] = ["0_to_5c", "minus10_to_0c", "below_minus10c"];
    const isTolerant = frostFriendlyBands.includes(minimum.value);
    const evidence: Evidence[] = [
      ...minimum.evidence,
      {
        source: { id: "derived", name: SOURCE_NAMES.derived },
        signal: `Derived frost tolerance from minimum band ${minimum.value}`,
        notes: "Bands at or below 5C imply frost tolerance."
      }
    ];
    const confidence: Confidence = {
      level: minimum.confidence.level === "high" ? "high" : "medium",
      score: minimum.confidence.score,
      rationale: "Inherited from minimum temperature band."
    };
    return {
      value: isTolerant,
      evidence,
      confidence
    };
  }

  private composeSoil({
    drainage,
    moisture,
    texture,
    ph
  }: {
    drainage?: CareValue<SoilDrainage>;
    moisture?: CareValue<SoilMoisture>;
    texture?: CareValue<SoilTexture[]>;
    ph?: CareValue<SoilPh[]>;
  }): CareProfile["soil"] | undefined {
    if (!drainage && !moisture && !texture && !ph) return undefined;
    return { drainage, moisture, texture, ph };
  }

  private composeBloom(corpus: ReturnType<typeof collectSignalCorpus>): CareProfile["bloom"] | undefined {
    const seasonalitySources = corpus.seasonality;
    if (!seasonalitySources || seasonalitySources.length === 0) return undefined;

    const monthTotals = new Map<number, number>();
    for (const record of seasonalitySources) {
      for (const entry of record.histogram) {
        const clampedMonth = Number.isFinite(entry.month) ? entry.month : NaN;
        if (!Number.isInteger(clampedMonth) || clampedMonth < 1 || clampedMonth > 12) continue;
        monthTotals.set(clampedMonth, (monthTotals.get(clampedMonth) ?? 0) + entry.observationCount);
      }
    }

    const months: MonthNumber[] = Array.from(monthTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([month]) => month as MonthNumber);

    if (months.length === 0) return undefined;

    const evidence: Evidence[] = seasonalitySources.map((record) => ({
      source: {
        id: record.sourceId,
        name: SOURCE_NAMES[record.sourceId] ?? record.sourceId,
        url: record.url
      },
      signal: "Observation histogram (month)",
      notes: "Top observation months used as bloom proxy."
    }));

    return {
      default: {
        value: { months },
        confidence: weightToConfidence({
          weight: Math.min(2, months.length * 0.4),
          evidenceCount: evidence.length,
          structuredOverride: true
        }),
        evidence
      }
    };
  }

  private composeEstablishment(corpus: ReturnType<typeof collectSignalCorpus>): CareProfile["establishment"] | undefined {
    const records = corpus.bundle.inat?.signals.establishment;
    const global = corpus.bundle.inat?.signals.globalEstablishment;
    if (!records && !global) return undefined;

    const evidenceBase: Evidence = {
      source: {
        id: "inat",
        name: SOURCE_NAMES.inat,
        url: corpus.bundle.inat?.context.url
      },
      signal: "Establishment means from iNaturalist"
    };

    return {
      global: global
        ? {
            value: normalizeEstablishmentStatus(global),
            confidence: weightToConfidence({
              weight: 1.5,
              evidenceCount: 1,
              structuredOverride: true
            }),
            evidence: [evidenceBase]
          }
        : undefined,
      regional: records
        ? records.map((record) => ({
            placeId: record.placeId,
            placeName: record.placeName,
            status: normalizeEstablishmentStatus(record.status),
            confidence: weightToConfidence({
              weight: 1.2,
              evidenceCount: 1,
              structuredOverride: true
            }),
            evidence: [evidenceBase]
          }))
        : undefined
    };
  }

  private composeElevation(corpus: ReturnType<typeof collectSignalCorpus>): CareProfile["elevation"] | undefined {
    const elevation = corpus.bundle.powo?.signals.elevationMeters;
    if (!elevation || (elevation.min == null && elevation.max == null)) return undefined;

    return {
      value: { minMeters: elevation.min ?? undefined, maxMeters: elevation.max ?? undefined },
      confidence: weightToConfidence({
        weight: 1.6,
        evidenceCount: 1,
        structuredOverride: true
      }),
      evidence: [
        {
          source: {
            id: "powo",
            name: SOURCE_NAMES.powo,
            url: corpus.bundle.powo?.context.url
          },
          signal: "Elevation range (m) from POWO"
        }
      ]
    };
  }

  private toEvidence<T>(match: KeywordMatch<T>, field: string, value: T): Evidence {
    const truncated = match.token.text.length > 120 ? `${match.token.text.slice(0, 117)}...` : match.token.text;
    return {
      source: {
        id: match.token.sourceId,
        name: SOURCE_NAMES[match.token.sourceId] ?? match.token.sourceId,
        url: match.token.url
      },
      signal: `Keyword match for ${field}`,
      notes: match.rule.rationale ?? `Matched text: "${truncated}" -> ${String(value)}`
    };
  }
}

const normalizeEstablishmentStatus = (status?: string | null): EstablishmentStatus => {
  const normalized = status?.toLowerCase().trim();
  switch (normalized) {
    case "native":
    case "endemic":
      return "native";
    case "introduced":
    case "naturalized":
    case "cultivated":
      return "introduced";
    case "invasive":
      return "invasive";
    default:
      return "uncertain";
  }
};

