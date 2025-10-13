import {
  type CareProfile,
  type Confidence,
  type Evidence,
  type HumidityLevel,
  type LightLevel,
  type SoilDrainage,
  type SoilMoisture,
  type SoilPh,
  type SoilTexture,
  type TemperatureBand,
  type ToleranceFlag,
  type WaterNeed
} from "../schema";

export interface ScenarioHint {
  summary: string;
  details?: string[];
  confidence?: Confidence;
  evidence?: Evidence[];
}

export interface ScenarioRecommendations {
  light?: ScenarioHint;
  water?: ScenarioHint;
  humidity?: ScenarioHint;
  temperature?: ScenarioHint;
  soil?: ScenarioHint;
  bonus?: ScenarioHint[];
}

type Scenario = "indoor" | "outdoor";

const indoorLightAdvice: Record<LightLevel, string> = {
  full_sun: "Give it the brightest spot you have—direct sun for 4–6 hours or supplement with grow lights.",
  partial_sun: "Park it near an east or west window with a few hours of gentle sun and bright light the rest of the day.",
  bright_indirect: "Keep it a few feet back from a bright window or behind a sheer curtain to avoid harsh rays.",
  full_shade: "It tolerates lower light; a bright room or north window will keep it happy."
};

const outdoorLightAdvice: Record<LightLevel, string> = {
  full_sun: "Site it in open sun with at least 6 hours of direct light.",
  partial_sun: "Morning sun with afternoon shade or light dappled cover is ideal.",
  bright_indirect: "Bright shade or filtered canopy light keeps foliage from scorching.",
  full_shade: "Deep shade is acceptable; under mature trees or on the north side of structures works well."
};

const indoorWaterAdvice: Record<WaterNeed, string> = {
  very_low: "Let the mix dry almost completely between thorough waterings (every 3–4 weeks).",
  low: "Water when the top half of the mix is dry—roughly every 2–3 weeks in bright rooms.",
  medium: "Keep the mix lightly moist; water when the top inch dries out (about weekly).",
  high: "Never let it fully dry; water when the surface feels barely dry and ensure excess drains.",
  aquatic: "Keep roots sitting in water or a constantly saturated medium."
};

const outdoorWaterAdvice: Record<WaterNeed, string> = {
  very_low: "Once established, natural rainfall is usually enough; water deeply only during prolonged drought.",
  low: "Water deeply when the top few inches of soil dry, typically every couple of weeks.",
  medium: "Provide consistent moisture; 2.5cm (~1 inch) of water weekly from rain or irrigation keeps it vigorous.",
  high: "Soil should stay wet; add supplemental watering or site near a water source.",
  aquatic: "Grow with feet in water or saturated bog soil year-round."
};

const humidityAdvice: Record<HumidityLevel, string> = {
  low: "Average household humidity is fine; avoid placing directly over heating vents.",
  medium: "Aim for 40–60% humidity—group plants or use a pebble tray if air is dry.",
  high: "Target 60%+ humidity; run a humidifier, grow in a bathroom, or use a terrarium cabinet."
};

const temperatureAdviceIndoor: Record<TemperatureBand, string> = {
  above_15c: "Keep above 60°F (15°C); cold drafts will stunt foliage.",
  "10_to_15c": "Prefers 55–65°F (13–18°C); brief dips to 50°F (10°C) are ok, but avoid colder.",
  "5_to_10c": "Can handle 40s°F (5–10°C), yet avoid frost indoors and protect from chilly windows.",
  "0_to_5c": "Cool-tolerant—down to near-freezing—but avoid frost and cold, wet soil indoors.",
  minus10_to_0c: "Hardy to moderate freezes, though indoor plants rarely need temps below 20°F (-6°C).",
  below_minus10c: "Cold hardy—survives deep freezes—yet keep indoor specimens above freezing to avoid dormancy shock."
};

const temperatureAdviceOutdoor: Record<TemperatureBand, string> = {
  above_15c: "Treat as a tender tropical outdoors—temperatures below 60°F (15°C) can cause damage.",
  "10_to_15c": "Protect from frost; temperatures below 50°F (10°C) may stress foliage.",
  "5_to_10c": "Handles light frost; mulch roots if temperatures fall below 40°F (5°C).",
  "0_to_5c": "Hardy to light freezes; shield from harsh wind and ensure good drainage in winter.",
  minus10_to_0c: "Cold hardy to moderate freezes; mulch and avoid waterlogged soil in winter.",
  below_minus10c: "Very cold hardy—suited to heavy freezes; ensure winter drainage for best survival."
};

const soilDrainageAdvice: Record<SoilDrainage, string> = {
  fast: "Prefers fast-draining media; add perlite, bark, or sand to improve aeration.",
  medium: "Standard well-draining potting mix or garden loam works well.",
  slow: "Handles heavier soils; still avoid prolonged waterlogging.",
  standing_water_ok: "Comfortable in saturated soils; can grow in boggy or standing water conditions."
};

const soilMoistureAdvice: Record<SoilMoisture, string> = {
  dry: "Allow soil to dry well between waterings.",
  evenly_moist: "Maintain consistent, even moisture—never soggy, never bone dry.",
  wet: "Keep soil wet or waterlogged; consider using trays or reservoirs."
};

const soilTextureLabels: Record<SoilTexture, string> = {
  sand: "sandy",
  loam: "loamy",
  clay: "clay-rich",
  rocky: "gritty"
};

const soilPhAdvice: Record<SoilPh, string> = {
  acidic: "Acidic conditions (pH < 6) suit it best.",
  neutral: "Neutral soils (pH ~6.5–7.5) are ideal.",
  alkaline: "Alkaline soils (pH > 7.5) keep it happiest."
};

const toleranceNotes: Partial<Record<ToleranceFlag, string>> = {
  drought: "Tolerates drought once established.",
  shade: "Handles lower light or understory conditions.",
  salt: "Coastal and salt-spray tolerant.",
  wind: "Adapted to windy, exposed sites."
};

export const joinList = (items: string[]): string => {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
};

const describeSoil = (profile: CareProfile): ScenarioHint | undefined => {
  const segments: string[] = [];
  const evidence: Evidence[] = [];
  let confidence: Confidence | undefined;

  if (profile.soil?.drainage) {
    segments.push(soilDrainageAdvice[profile.soil.drainage.value]);
    evidence.push(...(profile.soil.drainage.evidence ?? []));
    confidence = profile.soil.drainage.confidence;
  }
  if (profile.soil?.moisture) {
    segments.push(soilMoistureAdvice[profile.soil.moisture.value]);
    evidence.push(...(profile.soil.moisture.evidence ?? []));
    confidence = profile.soil.moisture.confidence ?? confidence;
  }
  if (profile.soil?.texture && profile.soil.texture.value.length > 0) {
    segments.push(`Thrives in ${joinList(profile.soil.texture.value.map((t) => soilTextureLabels[t]))} mixes.`);
    evidence.push(...(profile.soil.texture.evidence ?? []));
    confidence = profile.soil.texture.confidence ?? confidence;
  }
  if (profile.soil?.ph && profile.soil.ph.value.length > 0) {
    segments.push(soilPhAdvice[profile.soil.ph.value[0]]);
    evidence.push(...(profile.soil.ph.evidence ?? []));
    confidence = profile.soil.ph.confidence ?? confidence;
  }

  if (segments.length === 0) return undefined;

  return {
    summary: segments.join(" "),
    confidence,
    evidence
  };
};

const describeTolerances = (profile: CareProfile): ScenarioHint | undefined => {
  if (!profile.tolerances || profile.tolerances.value.length === 0) return undefined;
  const notes = profile.tolerances.value
    .map((flag) => toleranceNotes[flag])
    .filter((note): note is string => Boolean(note));
  if (notes.length === 0) return undefined;

  return {
    summary: notes.join(" "),
    confidence: profile.tolerances.confidence,
    evidence: profile.tolerances.evidence
  };
};

const describeTemperature = (
  band: TemperatureBand | undefined,
  scenario: Scenario,
  confidence?: Confidence,
  evidence?: Evidence[]
): ScenarioHint | undefined => {
  if (!band) return undefined;
  const map = scenario === "indoor" ? temperatureAdviceIndoor : temperatureAdviceOutdoor;
  return {
    summary: map[band],
    confidence,
    evidence
  };
};

export const buildIndoorRecommendations = (profile: CareProfile): ScenarioRecommendations => {
  const rec: ScenarioRecommendations = {};

  if (profile.light && profile.light.value.length > 0) {
    const primary = profile.light.value[0];
    rec.light = {
      summary: indoorLightAdvice[primary],
      details:
        primary === "full_sun"
          ? ["Rotate the container every few weeks and consider supplemental grow lights in winter."]
          : ["Rotate monthly for even growth and dust foliage so light penetrates."],
      confidence: profile.light.confidence,
      evidence: profile.light.evidence
    };
  }

  if (profile.water) {
    rec.water = {
      summary: indoorWaterAdvice[profile.water.value],
      details:
        profile.water.value === "high"
          ? ["Use a moisture meter or feel the mix often—never let it dry completely."]
          : profile.water.value === "very_low"
          ? ["Use a porous pot and gritty mix to prevent soggy roots."]
          : undefined,
      confidence: profile.water.confidence,
      evidence: profile.water.evidence
    };
  }

  if (profile.humidity) {
    rec.humidity = {
      summary: humidityAdvice[profile.humidity.value],
      details:
        profile.humidity.value === "high"
          ? ["Pebble trays, humidifiers, or grow cabinets help keep humidity above 60%.", "Misting alone rarely raises humidity enough."]
          : profile.humidity.value === "medium"
          ? ["Grouping plants together keeps humidity from dropping too low."]
          : undefined,
      confidence: profile.humidity.confidence,
      evidence: profile.humidity.evidence
    };
  }

  if (profile.temperature?.minimum) {
    rec.temperature = describeTemperature(
      profile.temperature.minimum.value,
      "indoor",
      profile.temperature.minimum.confidence,
      profile.temperature.minimum.evidence
    );
  }

  const soil = describeSoil(profile);
  if (soil) {
    rec.soil = soil;
  }

  const tolerances = describeTolerances(profile);
  if (tolerances) {
    rec.bonus = [tolerances];
  }

  return rec;
};

export const buildOutdoorRecommendations = (profile: CareProfile): ScenarioRecommendations => {
  const rec: ScenarioRecommendations = {};

  if (profile.light && profile.light.value.length > 0) {
    const primary = profile.light.value[0];
    rec.light = {
      summary: outdoorLightAdvice[primary],
      details:
        primary === "full_sun"
          ? ["Provide at least 6 hours of direct sun; in hot climates, afternoon shade prevents leaf scorch."]
          : primary === "bright_indirect"
          ? ["Understory plantings or north/east exposures prevent bleaching."]
          : undefined,
      confidence: profile.light.confidence,
      evidence: profile.light.evidence
    };
  }

  if (profile.water) {
    rec.water = {
      summary: outdoorWaterAdvice[profile.water.value],
      details:
        profile.water.value === "medium"
          ? ["Mulch helps retain moisture and keeps roots cool."]
          : profile.water.value === "high"
          ? ["Consider irrigation lines or planting near a water source."]
          : undefined,
      confidence: profile.water.confidence,
      evidence: profile.water.evidence
    };
  }

  if (profile.temperature?.minimum) {
    rec.temperature = describeTemperature(
      profile.temperature.minimum.value,
      "outdoor",
      profile.temperature.minimum.confidence,
      profile.temperature.minimum.evidence
    );
  }

  const soil = describeSoil(profile);
  if (soil) {
    const details = soil.details ? [...soil.details] : [];
    soil.details = details;
    if (profile.soil?.drainage?.value === "fast") {
      details.push("Raised beds or sloped sites prevent water pooling around the root zone.");
    }
    rec.soil = soil;
  }

  const bonus: ScenarioHint[] = [];

  if (profile.temperature?.frostTolerance) {
    bonus.push({
      summary: profile.temperature.frostTolerance.value
        ? "Frost tolerant once established—mulch crowns to buffer extreme freezes."
        : "Not frost tolerant; plan to overwinter indoors or cover during cold snaps.",
      confidence: profile.temperature.frostTolerance.confidence,
      evidence: profile.temperature.frostTolerance.evidence
    });
  }

  const tolerances = describeTolerances(profile);
  if (tolerances) bonus.push(tolerances);

  if (profile.establishment?.global) {
    const status = profile.establishment.global.value;
    if (status === "introduced" || status === "invasive") {
      bonus.push({
        summary:
          status === "invasive"
            ? "Flagged as invasive in some regions—check local guidance before planting outdoors."
            : "Introduced outside its native range—monitor spread and dispose of clippings responsibly.",
        confidence: profile.establishment.global.confidence,
        evidence: profile.establishment.global.evidence
      });
    }
  }

  if (bonus.length > 0) {
    rec.bonus = bonus;
  }

  return rec;
};
