import { describe, expect, it } from "vitest";

import {
  commandTopic,
  deviceStateTopic,
  etMetricsTopic,
  irrigationCommandTopic,
  legacyStatusTopic,
  legacyTelemetryTopic,
  parseCanonicalTopic,
  parseDeviceStateTopic,
  parseLegacyFirmwareTopic,
  parsePlantTopic,
  parseTopic,
  plantTelemetryTopic,
  sensorTopic,
  statusTopic
} from "../src/topics";

describe("protocol topics", () => {
  it("generates canonical pot topics", () => {
    expect(sensorTopic("pot-a")).toBe("pots/pot-a/sensors");
    expect(statusTopic("pot-a")).toBe("pots/pot-a/status");
    expect(commandTopic("pot-a")).toBe("pots/pot-a/command");
  });

  it("generates legacy, state, ping-adjacent, and ETkc topics", () => {
    expect(legacyTelemetryTopic("pot-a")).toBe("projectplant/pots/pot-a/telemetry");
    expect(legacyStatusTopic("pot-a")).toBe("projectplant/pots/pot-a/status");
    expect(deviceStateTopic("device-1")).toBe("plant/device-1/state");
    expect(plantTelemetryTopic("plant-1")).toBe("plant/plant-1/telemetry");
    expect(etMetricsTopic("plant-1")).toBe("plant/plant-1/et/metrics");
    expect(irrigationCommandTopic("plant-1")).toBe("plant/plant-1/irrigation/cmd");
  });

  it("parses supported topic families", () => {
    expect(parseCanonicalTopic("pots/pot-a/sensors")).toEqual({
      namespace: "canonical",
      potId: "pot-a",
      kind: "sensors"
    });
    expect(parseLegacyFirmwareTopic("projectplant/pots/pot-a/telemetry")).toEqual({
      namespace: "legacy-firmware",
      potId: "pot-a",
      kind: "telemetry"
    });
    expect(parseDeviceStateTopic("plant/device-1/state")).toEqual({
      namespace: "device-state",
      deviceId: "device-1"
    });
    expect(parsePlantTopic("plant/plant-1/et/metrics")).toEqual({
      namespace: "plant",
      plantId: "plant-1",
      kind: "et/metrics"
    });
    expect(parseTopic("plant/plant-1/irrigation/cmd")).toEqual({
      namespace: "plant",
      plantId: "plant-1",
      kind: "irrigation/cmd"
    });
  });

  it("rejects invalid topic ids and unknown topic kinds", () => {
    expect(() => sensorTopic("bad/id")).toThrow(/single MQTT topic segment/);
    expect(parseCanonicalTopic("pots/pot-a/unknown")).toBeNull();
    expect(parseTopic("unrelated/topic")).toBeNull();
  });
});
