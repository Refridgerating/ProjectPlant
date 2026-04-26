export type DeviceTopicKind = "sensors" | "status" | "command";
export type PlantTopicKind = "telemetry" | "et/metrics" | "irrigation/cmd";

export interface ParsedDeviceTopic {
  namespace: "canonical";
  potId: string;
  kind: DeviceTopicKind;
}

export interface ParsedLegacyFirmwareTopic {
  namespace: "legacy-firmware";
  potId: string;
  kind: "telemetry" | "status";
}

export interface ParsedDeviceStateTopic {
  namespace: "device-state";
  deviceId: string;
}

export interface ParsedPlantTopic {
  namespace: "plant";
  plantId: string;
  kind: PlantTopicKind;
}

export type ParsedTopic = ParsedDeviceTopic | ParsedLegacyFirmwareTopic | ParsedDeviceStateTopic | ParsedPlantTopic;

export const CANONICAL_TOPIC_PREFIX = "pots";
export const LEGACY_FIRMWARE_PREFIX = "projectplant/pots";
export const DEVICE_STATE_FILTER = "plant/+/state";
export const PLANT_TELEMETRY_FILTER = "plant/+/telemetry";
export const MQTT_PING_TOPIC = "lab/ping";

export const CANONICAL_SENSOR_FILTER = "pots/+/sensors";
export const CANONICAL_STATUS_FILTER = "pots/+/status";
export const CANONICAL_COMMAND_FILTER = "pots/+/command";
export const LEGACY_FIRMWARE_TELEMETRY_FILTER = "projectplant/pots/+/telemetry";
export const LEGACY_FIRMWARE_STATUS_FILTER = "projectplant/pots/+/status";

export function potTopic(potId: string, kind: DeviceTopicKind): string {
  assertTopicId(potId, "potId");
  return `${CANONICAL_TOPIC_PREFIX}/${potId}/${kind}`;
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

export function legacyTelemetryTopic(potId: string): string {
  assertTopicId(potId, "potId");
  return `${LEGACY_FIRMWARE_PREFIX}/${potId}/telemetry`;
}

export function legacyStatusTopic(potId: string): string {
  assertTopicId(potId, "potId");
  return `${LEGACY_FIRMWARE_PREFIX}/${potId}/status`;
}

export function deviceStateTopic(deviceId: string): string {
  assertTopicId(deviceId, "deviceId");
  return `plant/${deviceId}/state`;
}

export function plantTelemetryTopic(plantId: string): string {
  assertTopicId(plantId, "plantId");
  return `plant/${plantId}/telemetry`;
}

export function etMetricsTopic(plantId: string): string {
  assertTopicId(plantId, "plantId");
  return `plant/${plantId}/et/metrics`;
}

export function irrigationCommandTopic(plantId: string): string {
  assertTopicId(plantId, "plantId");
  return `plant/${plantId}/irrigation/cmd`;
}

export function parseCanonicalTopic(topic: string): ParsedDeviceTopic | null {
  const parts = topic.split("/");
  if (parts.length !== 3) {
    return null;
  }
  const [prefix, potId, kind] = parts;
  if (prefix !== CANONICAL_TOPIC_PREFIX || !potId) {
    return null;
  }
  if (kind === "sensors" || kind === "status" || kind === "command") {
    return { namespace: "canonical", potId, kind };
  }
  return null;
}

export function parseSensorTopic(topic: string): string | null {
  const parsed = parseCanonicalTopic(topic);
  return parsed?.kind === "sensors" ? parsed.potId : null;
}

export function parseLegacyFirmwareTopic(topic: string): ParsedLegacyFirmwareTopic | null {
  const parts = topic.split("/");
  if (parts.length !== 4) {
    return null;
  }
  const [project, pots, potId, kind] = parts;
  if (project !== "projectplant" || pots !== "pots" || !potId) {
    return null;
  }
  if (kind === "telemetry" || kind === "status") {
    return { namespace: "legacy-firmware", potId, kind };
  }
  return null;
}

export function parseDeviceStateTopic(topic: string): ParsedDeviceStateTopic | null {
  const parts = topic.split("/");
  if (parts.length === 3 && parts[0] === "plant" && parts[2] === "state" && parts[1]) {
    return { namespace: "device-state", deviceId: parts[1] };
  }
  return null;
}

export function parsePlantTopic(topic: string): ParsedPlantTopic | null {
  const parts = topic.split("/");
  if (parts.length < 3 || parts[0] !== "plant" || !parts[1]) {
    return null;
  }
  if (parts.length === 3 && parts[2] === "telemetry") {
    return { namespace: "plant", plantId: parts[1], kind: "telemetry" };
  }
  if (parts.length === 4 && parts[2] === "et" && parts[3] === "metrics") {
    return { namespace: "plant", plantId: parts[1], kind: "et/metrics" };
  }
  if (parts.length === 4 && parts[2] === "irrigation" && parts[3] === "cmd") {
    return { namespace: "plant", plantId: parts[1], kind: "irrigation/cmd" };
  }
  return null;
}

export function parseTopic(topic: string): ParsedTopic | null {
  return (
    parseCanonicalTopic(topic) ??
    parseLegacyFirmwareTopic(topic) ??
    parseDeviceStateTopic(topic) ??
    parsePlantTopic(topic)
  );
}

function assertTopicId(value: string, label: string): void {
  if (!value || value.includes("/") || value.includes("+") || value.includes("#")) {
    throw new Error(`${label} is required and must be a single MQTT topic segment`);
  }
}
