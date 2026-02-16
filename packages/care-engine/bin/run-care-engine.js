#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = join(__dirname, "..", "dist", "cli", "run-care-engine.js");

if (!existsSync(distEntry)) {
  console.error(
    "projectplant-care-engine: CLI not built. Run `pnpm --filter @projectplant/care-engine build` first."
  );
  process.exit(1);
}

await import(pathToFileURL(distEntry));
