import deviceCommandPayloadSchemaJson from "../schemas/device-command-payload.schema.json";
import deviceSchedulePayloadSchemaJson from "../schemas/device-schedule-payload.schema.json";
import deviceSensorPayloadSchemaJson from "../schemas/device-sensor-payload.schema.json";
import deviceStatusPayloadSchemaJson from "../schemas/device-status-payload.schema.json";
import legacyFirmwareStatusPayloadSchemaJson from "../schemas/legacy-firmware-status-payload.schema.json";
import legacyFirmwareTelemetryPayloadSchemaJson from "../schemas/legacy-firmware-telemetry-payload.schema.json";
export const deviceCommandPayloadSchema = deviceCommandPayloadSchemaJson;
export const deviceSchedulePayloadSchema = deviceSchedulePayloadSchemaJson;
export const deviceSensorPayloadSchema = deviceSensorPayloadSchemaJson;
export const deviceStatusPayloadSchema = deviceStatusPayloadSchemaJson;
export const legacyFirmwareTelemetryPayloadSchema = legacyFirmwareTelemetryPayloadSchemaJson;
export const legacyFirmwareStatusPayloadSchema = legacyFirmwareStatusPayloadSchemaJson;
export const protocolSchemas = {
    deviceCommandPayload: deviceCommandPayloadSchema,
    deviceSchedulePayload: deviceSchedulePayloadSchema,
    deviceSensorPayload: deviceSensorPayloadSchema,
    deviceStatusPayload: deviceStatusPayloadSchema,
    legacyFirmwareTelemetryPayload: legacyFirmwareTelemetryPayloadSchema,
    legacyFirmwareStatusPayload: legacyFirmwareStatusPayloadSchema
};
