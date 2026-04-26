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
} as const;

export type ActuatorValue = boolean | "on" | "off";

export interface DeviceScheduleTimer {
  enabled: boolean;
  startTime: string;
  endTime: string;
  [key: string]: unknown;
}

export interface DeviceSchedulePayload {
  light?: DeviceScheduleTimer;
  pump?: DeviceScheduleTimer;
  icZone1?: DeviceScheduleTimer;
  ic_zone1?: DeviceScheduleTimer;
  mister?: DeviceScheduleTimer;
  fan?: DeviceScheduleTimer;
  tzOffsetMinutes?: number;
  scheduleTimezonePosix?: string;
  scheduleUpdatedAtMs?: number;
  updatedAtMs?: number;
  [key: string]: unknown;
}

export interface DeviceCommandPayload {
  requestId?: string;
  request_id?: string;
  action?: "sensor_read" | "sensorRead";
  command?: "sensor_read" | "sensorRead";
  pump?: ActuatorValue;
  icZone1?: ActuatorValue;
  ic_zone1?: ActuatorValue;
  fan?: ActuatorValue;
  mister?: ActuatorValue;
  light?: ActuatorValue;
  duration_ms?: number;
  deviceName?: string;
  displayName?: string;
  sensorMode?: string;
  sensor_mode?: string;
  sensorsEnabled?: boolean;
  schedule?: DeviceSchedulePayload;
  tzOffsetMinutes?: number;
  scheduleTimezonePosix?: string;
  scheduleUpdatedAtMs?: number;
  updatedAtMs?: number;
  [key: string]: unknown;
}

export interface DeviceSensorPayload {
  potId: string;
  moisture: number;
  temperature: number;
  valveOpen: boolean;
  timestamp: string;
  humidity?: number;
  icZone1On?: boolean;
  fanOn?: boolean;
  misterOn?: boolean;
  lightOn?: boolean;
  flowRateLpm?: number;
  waterLow?: boolean;
  waterCutoff?: boolean;
  soilRaw?: number;
  timestampMs?: number;
  requestId?: string;
  deviceName?: string;
  displayName?: string;
  isNamed?: boolean;
  sensorMode?: string;
  source?: string;
  [key: string]: unknown;
}

export interface DeviceStatusPayload {
  potId?: string;
  status?: string;
  state?: string;
  fwVersion?: string;
  requestId?: string;
  request_id?: string;
  timestamp?: string;
  timestampMs?: number;
  timestamp_ms?: number;
  schedule?: DeviceSchedulePayload;
  [key: string]: unknown;
}

export type LegacyFirmwareTelemetryPayload = Record<string, unknown>;
export type LegacyFirmwareStatusPayload = Record<string, unknown>;
