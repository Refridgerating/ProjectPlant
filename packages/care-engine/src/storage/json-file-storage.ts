import { promises as fs, constants as fsConstants } from "fs";
import path from "path";
import type { CareProfile } from "../schema";
import type { StorageAdapter, StorageContext } from "./types";

export interface JsonFileStorageOptions {
  rootDir: string;
  /**
   * Produce human-readable JSON (2-space indent) when true.
   */
  pretty?: boolean;
  /**
   * Customize the file name (without directory) for a given profile.
   */
  filename?: (profile: CareProfile) => string;
}

const defaultFilename = (profile: CareProfile): string => {
  if (profile.taxon.powoId) {
    return sanitize(`${profile.taxon.powoId}.json`);
  }
  if (profile.taxon.inatId) {
    return sanitize(`inat-${profile.taxon.inatId}.json`);
  }
  return sanitize(`${profile.taxon.canonicalName.toLowerCase().replace(/\s+/g, "-")}.json`);
};

const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/g, "_");

export class JsonFileStorage implements StorageAdapter {
  private readonly rootDir: string;
  private readonly pretty: boolean;
  private readonly filenameFn: (profile: CareProfile) => string;

  constructor(options: JsonFileStorageOptions) {
    this.rootDir = options.rootDir;
    this.pretty = options.pretty ?? true;
    this.filenameFn = options.filename ?? defaultFilename;
  }

  async write({ profile, runId, generatedAt }: StorageContext): Promise<void> {
    const filename = this.filenameFn(profile);
    const fullPath = path.join(this.rootDir, filename);
    const payload = {
      runId,
      generatedAt,
      profile
    };

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, JSON.stringify(payload, null, this.pretty ? 2 : undefined), "utf8");
  }

  async read(taxonId: string): Promise<CareProfile | null> {
    const fullPath = path.join(this.rootDir, taxonId);
    try {
      await fs.access(fullPath, fsConstants.R_OK);
    } catch {
      return null;
    }
    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw) as { profile: CareProfile };
    return parsed.profile ?? null;
  }

  async *list(): AsyncIterable<CareProfile> {
    const entries = await fs.readdir(this.rootDir).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(this.rootDir, entry);
      const stat = await fs.lstat(fullPath);
      if (!stat.isFile()) continue;
      const raw = await fs.readFile(fullPath, "utf8");
      try {
        const parsed = JSON.parse(raw) as { profile?: CareProfile };
        if (parsed.profile) {
          yield parsed.profile;
        }
      } catch {
        continue;
      }
    }
  }
}

export const createJsonFileStorage = (options: JsonFileStorageOptions): JsonFileStorage =>
  new JsonFileStorage(options);
