import type { CareProfile } from "../schema";

export interface StorageContext {
  profile: CareProfile;
  /**
   * Identifier of the builder or batch run that produced the profile.
   */
  runId?: string;
  /**
   * Timestamp the builder completed (ISO-8601).
   */
  generatedAt: string;
}

export interface StorageAdapter {
  write(context: StorageContext): Promise<void>;
  read?(taxonId: string): Promise<CareProfile | null>;
  list?(): AsyncIterable<CareProfile>;
}
