import type {
  CareProfile,
  CareValue,
  GuidanceBlock,
  LightLevel,
  WaterNeed,
  HumidityLevel,
  TemperatureBand,
  SoilPh
} from "@projectplant/care-engine";
import type { PlantDetails, PlantCareProfile } from "../api/hubClient";

const LEGACY_SOURCE = { id: "projectplant-legacy", name: "ProjectPlant Legacy" };

const makeCareValue = <T>(value: T, original: string): CareValue<T> => ({
  value,
  confidence: { level: "medium", score: 0.6 },
  evidence: [
    {
      source: LEGACY_SOURCE,
      signal: original
    }
  ]
});

const normalizeLight = (input: string | null): LightLevel[] | undefined => {
  if (!input) return undefined;
  const value = input.toLowerCase();
  if (value.includes("full sun")) return ["full_sun"];
  if (value.includes("partial") || value.includes("part sun")) return ["partial_sun"];
  if (value.includes("shade")) return ["full_shade"];
  if (value.includes("indirect") || value.includes("bright")) return ["bright_indirect"];
  return ["bright_indirect"];
};

const normalizeWater = (input: string | null): WaterNeed | undefined => {
  if (!input) return undefined;
  const value = input.toLowerCase();
  if (value.includes("sparingly") || value.includes("dry") || value.includes("low")) return "very_low";
  if (value.includes("light") || value.includes("little")) return "low";
  if (value.includes("average") || value.includes("moderate")) return "medium";
  if (value.includes("heavy") || value.includes("frequent") || value.includes("high")) return "high";
  if (value.includes("water") && value.includes("standing")) return "aquatic";
  return "medium";
};

const normalizeHumidity = (input: string | null): HumidityLevel | undefined => {
  if (!input) return undefined;
  const value = input.toLowerCase();
  if (value.includes("high") || value.includes("humid")) return "high";
  if (value.includes("low") || value.includes("dry")) return "low";
  return "medium";
};

const normalizeTemperatureBand = (minC: number | null | undefined): TemperatureBand | undefined => {
  if (typeof minC !== "number" || Number.isNaN(minC)) return undefined;
  if (minC >= 15) return "above_15c";
  if (minC >= 10) return "10_to_15c";
  if (minC >= 5) return "5_to_10c";
  if (minC >= 0) return "0_to_5c";
  if (minC >= -10) return "minus10_to_0c";
  return "below_minus10c";
};

const normalizePh = (range: [number, number] | null | undefined): SoilPh | undefined => {
  if (!range) return undefined;
  const [min, max] = range;
  const avg = (Number(min) + Number(max)) / 2;
  if (!Number.isFinite(avg)) return undefined;
  if (avg < 6) return "acidic";
  if (avg > 7.5) return "alkaline";
  return "neutral";
};

const buildNotes = (care: PlantCareProfile): GuidanceBlock[] | undefined => {
  if (!care.notes?.trim()) return undefined;
  return [
    {
      id: "legacy-notes",
      context: "general",
      summary: care.notes.trim(),
      evidence: [
        {
          source: LEGACY_SOURCE,
          signal: "Legacy notes"
        }
      ]
    }
  ];
};

export function mapPlantCareProfileToCareProfile(detail: PlantDetails): CareProfile | null {
  const { care } = detail;
  if (!care) return null;

  const light = normalizeLight(care.light);
  const water = normalizeWater(care.water);
  const humidity = normalizeHumidity(care.humidity);
  const minTemperature = normalizeTemperatureBand(care.temperature_c?.[0]);
  const ph = normalizePh(care.ph_range);

  return {
    taxon: {
      canonicalName: detail.scientific_name,
      otherIds: {
        legacy_care_id: detail.id
      }
    },
    metadata: {
      schemaVersion: "legacy-plant-care-v1",
      inferenceVersion: "legacy-manual",
      generatedAt: new Date().toISOString()
    },
    light: light ? makeCareValue(light, care.light ?? "Legacy light recommendation") : undefined,
    water: water ? makeCareValue(water, care.water ?? "Legacy water recommendation") : undefined,
    humidity: humidity ? makeCareValue(humidity, care.humidity ?? "Legacy humidity recommendation") : undefined,
    temperature: minTemperature
      ? {
          minimum: makeCareValue(minTemperature, `Minimum ${care.temperature_c?.[0]}°C`)
        }
      : undefined,
    soil: ph
      ? {
          ph: makeCareValue([ph], `pH range ${care.ph_range?.join("–")}`)
        }
      : undefined,
    notes: buildNotes(care)
  };
}
