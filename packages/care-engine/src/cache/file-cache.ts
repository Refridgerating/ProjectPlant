import { promises as fs, constants as fsConstants } from "fs";
import path from "path";
import { createHash } from "crypto";
import type { CacheEntry, CacheProvider } from "./types";

export interface FileCacheOptions {
  rootDir: string;
  namespace?: string;
  /**
   * Use human-readable file names instead of hashes. Keys will be sanitized.
   */
  readableNames?: boolean;
}

export class FileCache implements CacheProvider {
  private readonly rootDir: string;
  private readonly namespace?: string;
  private readonly readableNames: boolean;

  constructor(options: FileCacheOptions) {
    this.rootDir = options.rootDir;
    this.namespace = options.namespace;
    this.readableNames = options.readableNames ?? false;
  }

  async read<TValue>(key: string): Promise<CacheEntry<TValue> | null> {
    const fullPath = this.keyToPath(key);
    try {
      await fs.access(fullPath, fsConstants.R_OK);
    } catch {
      return null;
    }

    const raw = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(raw) as CacheEntry<TValue>;
    return parsed;
  }

  async write<TValue>(entry: CacheEntry<TValue>): Promise<void> {
    const fullPath = this.keyToPath(entry.key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const payload = JSON.stringify(entry, null, 2);
    await fs.writeFile(fullPath, payload, "utf8");
  }

  async invalidate(key: string): Promise<void> {
    const fullPath = this.keyToPath(key);
    try {
      await fs.unlink(fullPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private keyToPath(key: string): string {
    const safeKey = this.readableNames ? this.sanitizeKey(key) : this.hashKey(key);
    const fileName = `${safeKey}.json`;
    return path.join(this.rootDir, this.namespace ?? "", fileName);
  }

  private hashKey(key: string): string {
    return createHash("sha1").update(key).digest("hex");
  }

  private sanitizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  }
}

export const createFileCache = (options: FileCacheOptions): FileCache => {
  return new FileCache(options);
};
