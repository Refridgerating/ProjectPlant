#!/usr/bin/env node
/**
 * Fetch raw adapter payloads for gold samples so regression tests can run offline.
 * Writes JSON files under test/fixtures/raw/<id>/ (powo.json, inat.json, gbif.json, wikipedia.json).
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { setTimeout as delay } from "timers/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const GOLD_PATH = path.join(ROOT, "test/fixtures/gold-samples.json");
const RAW_ROOT = path.join(ROOT, "test/fixtures/raw");

const POWO_BASE = "https://powo.science.kew.org/api/2";
const INAT_BASE = "https://api.inaturalist.org/v1";
const GBIF_BASE = "https://api.gbif.org/v1";
const WIKI_BASE = "https://en.wikipedia.org/api/rest_v1";

const readGold = async () => JSON.parse(await fs.readFile(GOLD_PATH, "utf8"));

const ensureDir = async (dir) => fs.mkdir(dir, { recursive: true });

const writeJson = async (fullPath, value) => {
  await fs.writeFile(fullPath, JSON.stringify(value, null, 2), "utf8");
  console.log(`wrote ${fullPath}`);
};

const fetchJson = async (url) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "ProjectPlantGoldFetcher/0.1.0" }
  });
  if (!res.ok) throw new Error(`Request failed ${res.status} ${res.statusText} for ${url}`);
  return res.json();
};

const fetchPowo = async (powoId) => {
  const candidates = [
    `${POWO_BASE}/taxon/${encodeURIComponent(powoId)}`,
    `${POWO_BASE.replace("/api/2", "/api/3")}/taxon/${encodeURIComponent(powoId)}`
  ];
  if (!powoId.startsWith("urn:lsid:")) {
    const lsid = `urn:lsid:ipni.org:names:${powoId}`;
    candidates.push(`${POWO_BASE}/taxon/${encodeURIComponent(lsid)}`);
    candidates.push(`${POWO_BASE.replace("/api/2", "/api/3")}/taxon/${encodeURIComponent(lsid)}`);
  }
  let lastError;
  for (const url of candidates) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

const fetchInat = async (inatId) => {
  const url = `${INAT_BASE}/taxa/${inatId}?all_names=true&locale=en`;
  const raw = await fetchJson(url);
  const taxon = raw?.results?.[0];
  if (!taxon) throw new Error(`No iNat taxon for ${inatId}`);
  return taxon;
};

const fetchGbif = async (gbifId) => {
  const url = `${GBIF_BASE}/occurrence/search?taxonKey=${gbifId}&limit=0&facet=month&facet=habitat&facetLimit=24`;
  return fetchJson(url);
};

const fetchWikipedia = async (canonicalName) => {
  const title = canonicalName.replace(/\s+/g, "_");
  const url = `${WIKI_BASE}/page/summary/${encodeURIComponent(title)}`;
  return fetchJson(url);
};

const main = async () => {
  const samples = await readGold();
  for (const sample of samples) {
    const { id, target } = sample;
    const rawDir = path.join(RAW_ROOT, id);
    await ensureDir(rawDir);

    const { powoId, inatId, gbifId } = target?.taxon ?? {};
    try {
      if (powoId) {
        const powo = await fetchPowo(powoId);
        await writeJson(path.join(rawDir, "powo.json"), powo);
      }
    } catch (error) {
      console.warn(`POWO fetch failed for ${id}: ${(error)?.message ?? error}`);
    }

    await delay(200); // mild pacing

    try {
      if (inatId != null) {
        const inat = await fetchInat(inatId);
        await writeJson(path.join(rawDir, "inat.json"), inat);
      }
    } catch (error) {
      console.warn(`iNat fetch failed for ${id}: ${(error)?.message ?? error}`);
    }

    await delay(200);

    try {
      if (gbifId) {
        const gbif = await fetchGbif(gbifId);
        await writeJson(path.join(rawDir, "gbif.json"), gbif);
      }
    } catch (error) {
      console.warn(`GBIF fetch failed for ${id}: ${(error)?.message ?? error}`);
    }

    await delay(200);

    try {
      if (target?.taxon?.canonicalName) {
        const wiki = await fetchWikipedia(target.taxon.canonicalName);
        await writeJson(path.join(rawDir, "wikipedia.json"), wiki);
      }
    } catch (error) {
      console.warn(`Wikipedia fetch failed for ${id}: ${(error)?.message ?? error}`);
    }

    await delay(200);
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
