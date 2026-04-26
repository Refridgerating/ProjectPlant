import { describe, expect, it } from "vitest";

import {
  isDeviceCommandPayload,
  isDeviceSensorPayload,
  isDeviceStatusPayload,
  isLegacyFirmwareStatusPayload,
  isLegacyFirmwareTelemetryPayload,
  validateDeviceCommandPayload
} from "../src/validators";

describe("protocol payload schemas", () => {
  it("accepts current command payloads", () => {
    expect(isDeviceCommandPayload({ requestId: "req-1", command: "sensor_read" })).toBe(true);
    expect(isDeviceCommandPayload({ requestId: "req-2", pump: "on", duration_ms: 1500 })).toBe(true);
    expect(isDeviceCommandPayload({ requestId: "req-3", icZone1: "off", duration_ms: 0 })).toBe(true);
    expect(isDeviceCommandPayload({ requestId: "req-4", fan: true, duration_ms: 2000 })).toBe(true);
    expect(isDeviceCommandPayload({ requestId: "req-5", mister: false })).toBe(true);
    expect(isDeviceCommandPayload({ requestId: "req-6", light: "on", duration_ms: 6000 })).toBe(true);
    expect(isDeviceCommandPayload({ requestId: "req-7", deviceName: "Window Basil" })).toBe(true);
    expect(isDeviceCommandPayload({ requestId: "req-8", sensorMode: "control_only" })).toBe(true);
  });

  it("accepts current schedule update command payloads", () => {
    expect(
      isDeviceCommandPayload({
        requestId: "sched-1",
        schedule: {
          light: { enabled: true, startTime: "06:00", endTime: "20:00" },
          pump: { enabled: false, startTime: "07:00", endTime: "07:15" },
          icZone1: { enabled: true, startTime: "08:00", endTime: "08:30" },
          mister: { enabled: false, startTime: "09:00", endTime: "09:15" },
          fan: { enabled: true, startTime: "10:00", endTime: "18:00" }
        },
        tzOffsetMinutes: -300,
        scheduleTimezonePosix: "EST5EDT,M3.2.0/2,M11.1.0/2",
        scheduleUpdatedAtMs: 1700000000000
      })
    ).toBe(true);
  });

  it("accepts current canonical sensor and status payloads", () => {
    expect(
      isDeviceSensorPayload({
        potId: "pot-a",
        moisture: 56.8,
        temperature: 21.3,
        humidity: 48.1,
        valveOpen: true,
        icZone1On: false,
        fanOn: true,
        misterOn: false,
        lightOn: true,
        waterLow: false,
        waterCutoff: false,
        soilRaw: 12345,
        timestampMs: 1700000000000,
        timestamp: "2023-11-14T22:13:20.000Z",
        requestId: "req-123"
      })
    ).toBe(true);

    expect(
      isDeviceStatusPayload({
        potId: "pot-a",
        status: "schedule_state",
        fwVersion: "0.1.0",
        schedulePaused: false,
        schedulePausedUntilMs: null,
        scheduleUpdatedAtMs: 1700000000000,
        scheduleTimezonePosix: "EST5EDT,M3.2.0/2,M11.1.0/2",
        tzOffsetMinutesCurrent: -300,
        timestampMs: 1700000000000,
        timestamp: "2023-11-14T22:13:20.000Z",
        schedule: {
          light: { enabled: true, startTime: "06:00", endTime: "20:00" }
        }
      })
    ).toBe(true);
  });

  it("accepts legacy firmware payloads", () => {
    expect(
      isLegacyFirmwareTelemetryPayload({
        soil_pct: "34.4",
        temperature_c: 21.5,
        humidity_pct: 50,
        pump_on: "off",
        request_id: "legacy-req"
      })
    ).toBe(true);
    expect(isLegacyFirmwareStatusPayload({ status: "pump_on", pump_on: true, requestId: "req-1" })).toBe(true);
  });

  it("rejects malformed command payloads", () => {
    expect(isDeviceCommandPayload({ requestId: "req-only" })).toBe(false);
    expect(isDeviceCommandPayload({ pump: "enabled" })).toBe(false);
    expect(
      isDeviceCommandPayload({
        schedule: {
          light: { enabled: true, startTime: "6am", endTime: "20:00" }
        }
      })
    ).toBe(false);
    expect(() => validateDeviceCommandPayload({ pump: "enabled" })).toThrow(/DeviceCommandPayload/);
  });
});
