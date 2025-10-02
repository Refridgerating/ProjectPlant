import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockBackend } from "../src/mock";

describe("mock backend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits sensor telemetry on an interval", () => {
    const backend = createMockBackend({ potCount: 1, intervalMs: 1000 });
    const updates: Array<{ moisture: number; temperature: number; valveOpen: boolean; timestamp: string }> = [];

    const unsubscribe = backend.subscribeSensor("pots/pot-1/sensors", (payload) => {
      updates.push({
        moisture: payload.moisture,
        temperature: payload.temperature,
        valveOpen: payload.valveOpen,
        timestamp: payload.timestamp
      });
    });

    expect(updates).toHaveLength(1);
    const first = updates[0];
    expect(first.timestamp).toBe("2024-01-01T00:00:00.000Z");
    expect(first.valveOpen).toBe(true);
    expect(first.moisture).toBeGreaterThanOrEqual(25);
    expect(first.moisture).toBeLessThanOrEqual(80);
    expect(first.temperature).toBeGreaterThanOrEqual(18);
    expect(first.temperature).toBeLessThanOrEqual(30);

    vi.advanceTimersByTime(1000);

    expect(updates).toHaveLength(2);
    const second = updates[1];
    expect(second.timestamp).toBe("2024-01-01T00:00:01.000Z");
    expect(second.valveOpen).toBeTypeOf("boolean");
    expect(second.moisture).toBeGreaterThanOrEqual(25);
    expect(second.moisture).toBeLessThanOrEqual(80);
    expect(second.temperature).toBeGreaterThanOrEqual(18);
    expect(second.temperature).toBeLessThanOrEqual(30);

    unsubscribe();
    backend.shutdown();
  });
});
