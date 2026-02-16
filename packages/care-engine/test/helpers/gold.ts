import path from "path";
import { fileURLToPath } from "url";
import { readFile, access } from "fs/promises";
import { constants as fsConstants } from "fs";
import {
  createGbifAdapter,
  createInatAdapter,
  createPowoAdapter,
  createWikipediaAdapter
} from "../../src/index.js";
import type { AdapterSignalBundle } from "../../src/engine/signal-collector.js";
import type { SourcePayload, SourceTarget } from "../../src/adapters/types";
import type { CareProfile, HumidityLevel, LightLevel, SoilDrainage, SoilMoisture, SoilPh, SoilTexture, TemperatureBand, ToleranceFlag, WaterNeed, PlantHabit } from "../../src/schema";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures");
const RAW_DIR = path.join(FIXTURE_DIR, "raw");
const GOLD_PATH = path.join(FIXTURE_DIR, "gold-samples.json");
const DEFAULT_FETCHED_AT = "2024-01-01T00:00:00.000Z";

export interface ExpectedFields {
  light?: LightLevel[];
  water?: WaterNeed;
  humidity?: HumidityLevel;
  temperatureMinimum?: TemperatureBand;
  soilDrainage?: SoilDrainage;
  soilMoisture?: SoilMoisture;
  soilTexture?: SoilTexture[];
  soilPh?: SoilPh[];
  tolerances?: ToleranceFlag[];
  habits?: PlantHabit[];
}

export interface GoldSample {
  id: string;
  target: SourceTarget;
  expected: ExpectedFields;
  notes?: string;
}

const maybeReadJson = async (fullPath: string): Promise<any | undefined> => {
  try {
    await access(fullPath, fsConstants.R_OK);
    const raw = await readFile(fullPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

export const loadGoldSamples = async (): Promise<GoldSample[]> => {
  const raw = await readFile(GOLD_PATH, "utf8");
  return JSON.parse(raw) as GoldSample[];
};

export const loadSignalsForSample = async (sample: GoldSample): Promise<AdapterSignalBundle | null> => {
  const baseDir = path.join(RAW_DIR, sample.id);
  const powoRaw = await maybeReadJson(path.join(baseDir, "powo.json"));
  const inatRaw = await maybeReadJson(path.join(baseDir, "inat.json"));
  const gbifRaw = await maybeReadJson(path.join(baseDir, "gbif.json"));
  const wikiRaw = await maybeReadJson(path.join(baseDir, "wikipedia.json"));

  if (!powoRaw && !inatRaw && !gbifRaw && !wikiRaw) {
    return null;
  }

  const bundle: AdapterSignalBundle = {};
  const context = { fetchedAt: DEFAULT_FETCHED_AT, fromCache: true as const, url: undefined };

  if (powoRaw) {
    const powoAdapter = createPowoAdapter();
    const payload: SourcePayload<any> = { raw: powoRaw, context };
    bundle.powo = (await powoAdapter.parse(payload)) as AdapterSignalBundle["powo"];
  }
  if (inatRaw) {
    const inatAdapter = createInatAdapter();
    const payload: SourcePayload<any> = { raw: { taxon: inatRaw }, context };
    bundle.inat = (await inatAdapter.parse(payload)) as AdapterSignalBundle["inat"];
  }
  if (gbifRaw) {
    const gbifAdapter = createGbifAdapter();
    const payload: SourcePayload<any> = { raw: gbifRaw, context };
    bundle.gbif = (await gbifAdapter.parse(payload)) as AdapterSignalBundle["gbif"];
  }
  if (wikiRaw) {
    const wikiAdapter = createWikipediaAdapter();
    const payload: SourcePayload<any> = { raw: wikiRaw, context };
    bundle.wikipedia = (await wikiAdapter.parse(payload)) as AdapterSignalBundle["wikipedia"];
  }

  return bundle;
};

export const assertExpectedFields = (profile: CareProfile, expected: ExpectedFields, expectFn: typeof expect): void => {
  const asserted: string[] = [];
  if (expected.light) {
    expectFn(profile.light?.value).toEqual(expected.light);
    asserted.push("light");
  }
  if (expected.water) {
    expectFn(profile.water?.value).toBe(expected.water);
    asserted.push("water");
  }
  if (expected.humidity) {
    expectFn(profile.humidity?.value).toBe(expected.humidity);
    asserted.push("humidity");
  }
  if (expected.temperatureMinimum) {
    expectFn(profile.temperature?.minimum?.value).toBe(expected.temperatureMinimum);
    asserted.push("temperatureMinimum");
  }
  if (expected.soilDrainage) {
    expectFn(profile.soil?.drainage?.value).toBe(expected.soilDrainage);
    asserted.push("soilDrainage");
  }
  if (expected.soilMoisture) {
    expectFn(profile.soil?.moisture?.value).toBe(expected.soilMoisture);
    asserted.push("soilMoisture");
  }
  if (expected.soilTexture) {
    expectFn(profile.soil?.texture?.value).toEqual(expected.soilTexture);
    asserted.push("soilTexture");
  }
  if (expected.soilPh) {
    expectFn(profile.soil?.ph?.value).toEqual(expected.soilPh);
    asserted.push("soilPh");
  }
  if (expected.tolerances) {
    expectFn(profile.tolerances?.value).toEqual(expected.tolerances);
    asserted.push("tolerances");
  }
  if (expected.habits) {
    expectFn(profile.habits?.value).toEqual(expected.habits);
    asserted.push("habits");
  }

  if (asserted.length === 0) {
    // eslint-disable-next-line no-console
    console.warn("No expected fields set for sample; add them to fixtures to enable regression coverage.");
  }
};
