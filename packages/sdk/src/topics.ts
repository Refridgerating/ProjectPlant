export {
  CANONICAL_TOPIC_PREFIX,
  LEGACY_FIRMWARE_PREFIX as LEGACY_TELEMETRY_PREFIX,
  commandTopic,
  legacyTelemetryTopic,
  parseCanonicalTopic,
  parseSensorTopic,
  potTopic,
  sensorTopic,
  statusTopic
} from "@projectplant/protocol/topics";

export type { DeviceTopicKind as TopicKind, ParsedDeviceTopic as ParsedTopic } from "@projectplant/protocol/topics";
