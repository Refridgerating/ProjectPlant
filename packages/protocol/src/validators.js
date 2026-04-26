import Ajv from "ajv";
import { deviceCommandPayloadSchema, deviceSchedulePayloadSchema, deviceSensorPayloadSchema, deviceStatusPayloadSchema, legacyFirmwareStatusPayloadSchema, legacyFirmwareTelemetryPayloadSchema } from "./schemas";
const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false
});
ajv.addSchema(deviceSchedulePayloadSchema);
const validators = {
    deviceCommandPayload: ajv.compile(deviceCommandPayloadSchema),
    deviceSchedulePayload: ajv.compile(deviceSchedulePayloadSchema),
    deviceSensorPayload: ajv.compile(deviceSensorPayloadSchema),
    deviceStatusPayload: ajv.compile(deviceStatusPayloadSchema),
    legacyFirmwareTelemetryPayload: ajv.compile(legacyFirmwareTelemetryPayloadSchema),
    legacyFirmwareStatusPayload: ajv.compile(legacyFirmwareStatusPayloadSchema)
};
export function isDeviceCommandPayload(input) {
    return validators.deviceCommandPayload(input);
}
export function isDeviceSchedulePayload(input) {
    return validators.deviceSchedulePayload(input);
}
export function isDeviceSensorPayload(input) {
    return validators.deviceSensorPayload(input);
}
export function isDeviceStatusPayload(input) {
    return validators.deviceStatusPayload(input);
}
export function isLegacyFirmwareTelemetryPayload(input) {
    return validators.legacyFirmwareTelemetryPayload(input);
}
export function isLegacyFirmwareStatusPayload(input) {
    return validators.legacyFirmwareStatusPayload(input);
}
export function validateDeviceCommandPayload(input) {
    return assertValid(input, validators.deviceCommandPayload, "DeviceCommandPayload");
}
export function validateDeviceSensorPayload(input) {
    return assertValid(input, validators.deviceSensorPayload, "DeviceSensorPayload");
}
export function validateDeviceStatusPayload(input) {
    return assertValid(input, validators.deviceStatusPayload, "DeviceStatusPayload");
}
export function validateLegacyFirmwareTelemetryPayload(input) {
    return assertValid(input, validators.legacyFirmwareTelemetryPayload, "LegacyFirmwareTelemetryPayload");
}
export function validateLegacyFirmwareStatusPayload(input) {
    return assertValid(input, validators.legacyFirmwareStatusPayload, "LegacyFirmwareStatusPayload");
}
function assertValid(input, validator, label) {
    if (validator(input)) {
        return input;
    }
    const details = (validator.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ");
    throw new Error(`${label} is invalid${details ? `: ${details}` : ""}`);
}
