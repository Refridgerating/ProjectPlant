import Ajv, { type ValidateFunction } from "ajv";

import {
  deviceCommandPayloadSchema,
  deviceSchedulePayloadSchema,
  deviceSensorPayloadSchema,
  deviceStatusPayloadSchema,
  legacyFirmwareStatusPayloadSchema,
  legacyFirmwareTelemetryPayloadSchema,
  type DeviceCommandPayload,
  type DeviceSchedulePayload,
  type DeviceSensorPayload,
  type DeviceStatusPayload,
  type LegacyFirmwareStatusPayload,
  type LegacyFirmwareTelemetryPayload
} from "./schemas";

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
} satisfies Record<string, ValidateFunction>;

export function isDeviceCommandPayload(input: unknown): input is DeviceCommandPayload {
  return validators.deviceCommandPayload(input);
}

export function isDeviceSchedulePayload(input: unknown): input is DeviceSchedulePayload {
  return validators.deviceSchedulePayload(input);
}

export function isDeviceSensorPayload(input: unknown): input is DeviceSensorPayload {
  return validators.deviceSensorPayload(input);
}

export function isDeviceStatusPayload(input: unknown): input is DeviceStatusPayload {
  return validators.deviceStatusPayload(input);
}

export function isLegacyFirmwareTelemetryPayload(input: unknown): input is LegacyFirmwareTelemetryPayload {
  return validators.legacyFirmwareTelemetryPayload(input);
}

export function isLegacyFirmwareStatusPayload(input: unknown): input is LegacyFirmwareStatusPayload {
  return validators.legacyFirmwareStatusPayload(input);
}

export function validateDeviceCommandPayload(input: unknown): DeviceCommandPayload {
  return assertValid(input, validators.deviceCommandPayload, "DeviceCommandPayload");
}

export function validateDeviceSensorPayload(input: unknown): DeviceSensorPayload {
  return assertValid(input, validators.deviceSensorPayload, "DeviceSensorPayload");
}

export function validateDeviceStatusPayload(input: unknown): DeviceStatusPayload {
  return assertValid(input, validators.deviceStatusPayload, "DeviceStatusPayload");
}

export function validateLegacyFirmwareTelemetryPayload(input: unknown): LegacyFirmwareTelemetryPayload {
  return assertValid(input, validators.legacyFirmwareTelemetryPayload, "LegacyFirmwareTelemetryPayload");
}

export function validateLegacyFirmwareStatusPayload(input: unknown): LegacyFirmwareStatusPayload {
  return assertValid(input, validators.legacyFirmwareStatusPayload, "LegacyFirmwareStatusPayload");
}

function assertValid<T>(input: unknown, validator: ValidateFunction, label: string): T {
  if (validator(input)) {
    return input as T;
  }
  const details = (validator.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
  throw new Error(`${label} is invalid${details ? `: ${details}` : ""}`);
}
