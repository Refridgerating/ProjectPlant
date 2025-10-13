export type TopicKind = "sensors" | "status" | "command";

const CANONICAL_PREFIX = "pots";

/**
 * Returns the canonical MQTT topic for the given pot and topic kind.
 */
export function potTopic(potId: string, kind: TopicKind): string {
  if (!potId) {
    throw new Error("potId is required");
  }
  return `${CANONICAL_PREFIX}/${potId}/${kind}`;
}

export function sensorTopic(potId: string): string {
  return potTopic(potId, "sensors");
}

export function statusTopic(potId: string): string {
  return potTopic(potId, "status");
}

export function commandTopic(potId: string): string {
  return potTopic(potId, "command");
}

export interface ParsedTopic {
  potId: string;
  kind: TopicKind;
}

export function parseCanonicalTopic(topic: string): ParsedTopic | null {
  const parts = topic.split("/");
  if (parts.length !== 3) {
    return null;
  }
  const [prefix, potId, kind] = parts;
  if (prefix !== CANONICAL_PREFIX) {
    return null;
  }
  if (kind === "sensors" || kind === "status" || kind === "command") {
    return { potId, kind };
  }
  return null;
}

export function parseSensorTopic(topic: string): string | null {
  const parsed = parseCanonicalTopic(topic);
  if (!parsed || parsed.kind !== "sensors") {
    return null;
  }
  return parsed.potId;
}

const LEGACY_FIRMWARE_PREFIX = "projectplant/pots";

/**
 * Legacy firmware topic for raw telemetry payloads.
 */
export function legacyTelemetryTopic(potId: string): string {
  if (!potId) {
    throw new Error("potId is required");
  }
  return `${LEGACY_FIRMWARE_PREFIX}/${potId}/telemetry`;
}

export const CANONICAL_TOPIC_PREFIX = CANONICAL_PREFIX;
export const LEGACY_TELEMETRY_PREFIX = LEGACY_FIRMWARE_PREFIX;
