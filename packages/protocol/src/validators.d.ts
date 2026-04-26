import { type DeviceCommandPayload, type DeviceSchedulePayload, type DeviceSensorPayload, type DeviceStatusPayload, type LegacyFirmwareStatusPayload, type LegacyFirmwareTelemetryPayload } from "./schemas";
export declare function isDeviceCommandPayload(input: unknown): input is DeviceCommandPayload;
export declare function isDeviceSchedulePayload(input: unknown): input is DeviceSchedulePayload;
export declare function isDeviceSensorPayload(input: unknown): input is DeviceSensorPayload;
export declare function isDeviceStatusPayload(input: unknown): input is DeviceStatusPayload;
export declare function isLegacyFirmwareTelemetryPayload(input: unknown): input is LegacyFirmwareTelemetryPayload;
export declare function isLegacyFirmwareStatusPayload(input: unknown): input is LegacyFirmwareStatusPayload;
export declare function validateDeviceCommandPayload(input: unknown): DeviceCommandPayload;
export declare function validateDeviceSensorPayload(input: unknown): DeviceSensorPayload;
export declare function validateDeviceStatusPayload(input: unknown): DeviceStatusPayload;
export declare function validateLegacyFirmwareTelemetryPayload(input: unknown): LegacyFirmwareTelemetryPayload;
export declare function validateLegacyFirmwareStatusPayload(input: unknown): LegacyFirmwareStatusPayload;
//# sourceMappingURL=validators.d.ts.map