import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sensorTopic, type SensorEvent } from "../src";

const discoverBridgeMock = vi.hoisted(() => ({
  discover: vi.fn<[], Promise<null>>(() => Promise.resolve(null))
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false)
  }
}));

vi.mock("@native/discover", () => ({
  DiscoverBridge: discoverBridgeMock,
  DEFAULT_DISCOVERY_HOST: "projectplant.local",
  DEFAULT_DISCOVERY_PORTS: [80, 8080],
  DEFAULT_DISCOVERY_TIMEOUT_MS: 10_000
}));

describe("sdk demo mode", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    discoverBridgeMock.discover.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects in demo mode and streams mock telemetry", async () => {
    const sdk = await import("../src");
    await sdk.connect({ mode: "demo" });

    const pots = await sdk.listPots();
    expect(pots.length).toBeGreaterThan(0);

    const events: SensorEvent[] = [];
    const unsubscribe = await sdk.subscribeSensor(sensorTopic("pot-1"), (event) => {
      events.push(event);
    });

    expect(events).toHaveLength(1);
    expect(events[0].origin).toBe("mock");
    expect(events[0].parsed?.potId).toBe("pot-1");

    vi.advanceTimersByTime(4000);

    expect(events).toHaveLength(3);
    expect(events.at(-1)?.parsed?.timestamp).toBe("2024-01-01T00:00:04.000Z");

    await unsubscribe();
  });

  it("throws when attempting live mode without base url", async () => {
    const sdk = await import("../src");
    await expect(sdk.connect({ mode: "live" })).rejects.toThrow(/baseUrl/);
  });
});
