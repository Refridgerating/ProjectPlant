import { createGbifAdapter, createInatAdapter, createPowoAdapter, createWikipediaAdapter } from "../adapters/index.js";
import type { SourceSignals } from "../adapters/index.js";
import type { SourcePayload } from "../adapters/types.js";
import type { InatSignals } from "../adapters/inat.js";
import type { PowoSignals } from "../adapters/powo.js";
import type { GbifSignals } from "../adapters/gbif.js";
import type { WikipediaSignals } from "../adapters/wikipedia.js";
import { RuleBasedCareEngine } from "../engine/rule-engine.js";
import type { AdapterSignalBundle } from "../engine/signal-collector.js";
import type { CareProfile } from "../schema.js";

interface RunnerInput {
  canonicalName?: string;
  powoId?: string | null;
  inatId?: number | string | null;
  gbifId?: number | string | null;
  placeCode?: string;
  powoBaseUrl?: string;
  inatBaseUrl?: string;
  gbifBaseUrl?: string;
  wikipediaBaseUrl?: string;
  schemaVersion?: string;
  inferenceVersion?: string;
  generatedAt?: string;
  powoRaw?: Record<string, unknown>;
  powoContextUrl?: string;
  inatRaw?: Record<string, unknown>;
  inatContextUrl?: string;
  gbifRaw?: Record<string, unknown>;
  gbifContextUrl?: string;
  wikipediaRaw?: Record<string, unknown>;
  wikipediaContextUrl?: string;
  wikipediaTitle?: string;
}

type RunnerOutput =
  | {
      ok: true;
      profile: CareProfile;
    }
  | {
      ok: false;
      error: string;
      warnings?: string[];
    };

const DEFAULT_POWO_BASE_URL = "https://powo.science.kew.org/api/3";
const DEFAULT_INAT_BASE_URL = "https://api.inaturalist.org/v1";
const DEFAULT_GBIF_BASE_URL = "https://api.gbif.org/v1";

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function writeOutput(payload: RunnerOutput): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: RunnerInput;
  try {
    input = raw ? (JSON.parse(raw) as RunnerInput) : {};
  } catch (error) {
    writeOutput({ ok: false, error: `Invalid JSON input: ${(error as Error).message}` });
    process.exitCode = 1;
    return;
  }

  const canonicalName = input.canonicalName?.trim();
  const powoId = input.powoId?.toString().trim() || undefined;
  const inatId =
    typeof input.inatId === "number"
      ? input.inatId
      : typeof input.inatId === "string"
      ? Number.parseInt(input.inatId, 10)
      : undefined;
  const gbifId =
    typeof input.gbifId === "number"
      ? input.gbifId
      : typeof input.gbifId === "string"
      ? Number.parseInt(input.gbifId, 10)
      : undefined;

  if (!canonicalName) {
    writeOutput({ ok: false, error: "canonicalName is required" });
    process.exitCode = 1;
    return;
  }

  if (!powoId && (inatId == null || Number.isNaN(inatId)) && (gbifId == null || Number.isNaN(gbifId))) {
    writeOutput({ ok: false, error: "At least one of powoId, gbifId, or inatId must be provided" });
    process.exitCode = 1;
    return;
  }

  const warnings: string[] = [];
  const bundle: AdapterSignalBundle = {};
  const target = {
    taxon: {
      canonicalName,
      powoId,
      inatId: typeof inatId === "number" && !Number.isNaN(inatId) ? inatId : undefined,
      gbifId: typeof gbifId === "number" && !Number.isNaN(gbifId) ? gbifId.toString() : undefined
    },
    placeCode: input.placeCode
  };

  if (input.powoRaw) {
    try {
      const powoAdapter = createPowoAdapter({ baseUrl: input.powoBaseUrl ?? DEFAULT_POWO_BASE_URL });
      const payload: SourcePayload<Record<string, unknown>> = {
        raw: input.powoRaw,
        context: {
          fetchedAt: input.generatedAt ?? new Date().toISOString(),
          fromCache: true,
          url: input.powoContextUrl
        }
      };
      bundle.powo = (await powoAdapter.parse(payload as SourcePayload<any>)) as SourceSignals<PowoSignals>;
    } catch (error) {
      warnings.push(`POWO parse failed: ${(error as Error).message}`);
    }
  } else if (powoId) {
    try {
      const powoAdapter = createPowoAdapter({ baseUrl: input.powoBaseUrl ?? DEFAULT_POWO_BASE_URL });
      const payload = await powoAdapter.fetch(target);
      bundle.powo = (await powoAdapter.parse(payload)) as SourceSignals<PowoSignals>;
    } catch (error) {
      warnings.push(`POWO fetch failed: ${(error as Error).message}`);
    }
  }

  if (input.inatRaw) {
    try {
      const inatAdapter = createInatAdapter({ baseUrl: input.inatBaseUrl ?? DEFAULT_INAT_BASE_URL });
      const payload: SourcePayload<Record<string, unknown>> = {
        raw: { taxon: input.inatRaw },
        context: {
          fetchedAt: input.generatedAt ?? new Date().toISOString(),
          fromCache: true,
          url: input.inatContextUrl
        }
      };
      bundle.inat = (await inatAdapter.parse(payload as SourcePayload<any>)) as SourceSignals<InatSignals>;
    } catch (error) {
      warnings.push(`iNaturalist parse failed: ${(error as Error).message}`);
    }
  } else if (typeof inatId === "number" && !Number.isNaN(inatId)) {
    try {
      const inatAdapter = createInatAdapter({ baseUrl: input.inatBaseUrl ?? DEFAULT_INAT_BASE_URL });
      const payload = await inatAdapter.fetch(target);
      bundle.inat = (await inatAdapter.parse(payload)) as SourceSignals<InatSignals>;
    } catch (error) {
      warnings.push(`iNaturalist fetch failed: ${(error as Error).message}`);
    }
  }

  if (input.gbifRaw) {
    try {
      const gbifAdapter = createGbifAdapter({ baseUrl: input.gbifBaseUrl ?? DEFAULT_GBIF_BASE_URL });
      const payload: SourcePayload<Record<string, unknown>> = {
        raw: input.gbifRaw,
        context: {
          fetchedAt: input.generatedAt ?? new Date().toISOString(),
          fromCache: true,
          url: input.gbifContextUrl
        }
      };
      bundle.gbif = (await gbifAdapter.parse(payload as SourcePayload<any>)) as SourceSignals<GbifSignals>;
    } catch (error) {
      warnings.push(`GBIF parse failed: ${(error as Error).message}`);
    }
  } else if (typeof gbifId === "number" && !Number.isNaN(gbifId)) {
    try {
      const gbifAdapter = createGbifAdapter({ baseUrl: input.gbifBaseUrl ?? DEFAULT_GBIF_BASE_URL });
      const payload = await gbifAdapter.fetch(target);
      bundle.gbif = (await gbifAdapter.parse(payload)) as SourceSignals<GbifSignals>;
    } catch (error) {
      warnings.push(`GBIF fetch failed: ${(error as Error).message}`);
    }
  }

  const wikipediaTitle = input.wikipediaTitle ?? canonicalName;
  if (input.wikipediaRaw) {
    try {
      const wikiAdapter = createWikipediaAdapter({ baseUrl: input.wikipediaBaseUrl ?? undefined });
      const payload: SourcePayload<Record<string, unknown>> = {
        raw: input.wikipediaRaw,
        context: {
          fetchedAt: input.generatedAt ?? new Date().toISOString(),
          fromCache: true,
          url: input.wikipediaContextUrl
        }
      };
      bundle.wikipedia = (await wikiAdapter.parse(payload as SourcePayload<any>)) as SourceSignals<WikipediaSignals>;
    } catch (error) {
      warnings.push(`Wikipedia parse failed: ${(error as Error).message}`);
    }
  } else if (wikipediaTitle) {
    try {
      const wikiAdapter = createWikipediaAdapter({ baseUrl: input.wikipediaBaseUrl ?? undefined });
      const payload = await wikiAdapter.fetch({
        taxon: { canonicalName: wikipediaTitle }
      });
      bundle.wikipedia = (await wikiAdapter.parse(payload)) as SourceSignals<WikipediaSignals>;
    } catch (error) {
      warnings.push(`Wikipedia fetch failed: ${(error as Error).message}`);
    }
  }

  if (!bundle.powo && !bundle.inat && !bundle.gbif) {
    writeOutput({
      ok: false,
      error: "No adapter data available to run inference",
      warnings: warnings.length ? warnings : undefined
    });
    process.exitCode = 1;
    return;
  }

  const engine = new RuleBasedCareEngine({
    schemaVersion: input.schemaVersion,
    inferenceVersion: input.inferenceVersion
  });

  const profile = engine.map({
    target,
    signals: bundle,
    generatedAt: input.generatedAt
  });

  writeOutput({ ok: true, profile });
}

main().catch((error) => {
  writeOutput({ ok: false, error: (error as Error).message });
  process.exitCode = 1;
});
