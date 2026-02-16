#!/usr/bin/env node
/**
 * Print care-engine outputs for the gold fixtures using the bundled CLI.
 * Requires a built CLI at dist/cli/run-care-engine.js (run `pnpm build` first).
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const FIXTURE_DIR = path.join(ROOT, "test", "fixtures");
const GOLD_PATH = path.join(FIXTURE_DIR, "gold-samples.json");
const RAW_DIR = path.join(FIXTURE_DIR, "raw");
const CLI_PATH = path.join(ROOT, "dist", "cli", "run-care-engine.js");

if (!existsSync(CLI_PATH)) {
  console.error(`CLI not found at ${CLI_PATH}. Run "pnpm build" inside packages/care-engine first.`);
  process.exit(1);
}

const gold = JSON.parse(readFileSync(GOLD_PATH, "utf8"));

const loadRaw = (id, name) => {
  const full = path.join(RAW_DIR, id, `${name}.json`);
  if (!existsSync(full)) return undefined;
  return JSON.parse(readFileSync(full, "utf8"));
};

const summarize = (profile) => ({
  light: profile.light?.value,
  water: profile.water?.value,
  humidity: profile.humidity?.value,
  tempMin: profile.temperature?.minimum?.value,
  soil: {
    drainage: profile.soil?.drainage?.value,
    moisture: profile.soil?.moisture?.value,
    texture: profile.soil?.texture?.value,
    ph: profile.soil?.ph?.value
  },
  habits: profile.habits?.value,
  tolerances: profile.tolerances?.value,
  inferenceVersion: profile.metadata?.inferenceVersion
});

for (const sample of gold) {
  const id = sample.id;
  const bundleInput = {
    canonicalName: sample.target.taxon.canonicalName,
    powoId: sample.target.taxon.powoId,
    inatId: sample.target.taxon.inatId,
    gbifId: sample.target.taxon.gbifId,
    powoRaw: loadRaw(id, "powo"),
    inatRaw: loadRaw(id, "inat"),
    gbifRaw: loadRaw(id, "gbif"),
    wikipediaRaw: loadRaw(id, "wikipedia")
  };

  const result = spawnSync("node", [CLI_PATH], {
    input: JSON.stringify(bundleInput),
    encoding: "utf8"
  });

  if (result.error) {
    console.error(`${id}: spawn error ${result.error.message}`);
    continue;
  }
  if (result.status !== 0) {
    console.error(`${id}: CLI failed`, result.stdout || result.stderr);
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    console.error(`${id}: failed to parse CLI output`, error);
    continue;
  }
  if (!parsed.ok) {
    console.error(`${id}: ${parsed.error}`);
    continue;
  }
  console.log(id, JSON.stringify(summarize(parsed.profile), null, 2));
}
