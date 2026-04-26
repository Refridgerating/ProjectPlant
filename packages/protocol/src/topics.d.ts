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
export declare const CANONICAL_TOPIC_PREFIX = "pots";
export declare const LEGACY_FIRMWARE_PREFIX = "projectplant/pots";
export declare const DEVICE_STATE_FILTER = "plant/+/state";
export declare const PLANT_TELEMETRY_FILTER = "plant/+/telemetry";
export declare const MQTT_PING_TOPIC = "lab/ping";
export declare const CANONICAL_SENSOR_FILTER = "pots/+/sensors";
export declare const CANONICAL_STATUS_FILTER = "pots/+/status";
export declare const CANONICAL_COMMAND_FILTER = "pots/+/command";
export declare const LEGACY_FIRMWARE_TELEMETRY_FILTER = "projectplant/pots/+/telemetry";
export declare const LEGACY_FIRMWARE_STATUS_FILTER = "projectplant/pots/+/status";
export declare function potTopic(potId: string, kind: DeviceTopicKind): string;
export declare function sensorTopic(potId: string): string;
export declare function statusTopic(potId: string): string;
export declare function commandTopic(potId: string): string;
export declare function legacyTelemetryTopic(potId: string): string;
export declare function legacyStatusTopic(potId: string): string;
export declare function deviceStateTopic(deviceId: string): string;
export declare function plantTelemetryTopic(plantId: string): string;
export declare function etMetricsTopic(plantId: string): string;
export declare function irrigationCommandTopic(plantId: string): string;
export declare function parseCanonicalTopic(topic: string): ParsedDeviceTopic | null;
export declare function parseSensorTopic(topic: string): string | null;
export declare function parseLegacyFirmwareTopic(topic: string): ParsedLegacyFirmwareTopic | null;
export declare function parseDeviceStateTopic(topic: string): ParsedDeviceStateTopic | null;
export declare function parsePlantTopic(topic: string): ParsedPlantTopic | null;
export declare function parseTopic(topic: string): ParsedTopic | null;
//# sourceMappingURL=topics.d.ts.map