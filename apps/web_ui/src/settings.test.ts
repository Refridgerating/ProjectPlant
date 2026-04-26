import { beforeEach, describe, expect, it, vi } from "vitest";

const discoverPiMock = vi.hoisted(() => vi.fn());
const isNativePlatformMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@projectplant/sdk", () => ({
  discoverPi: discoverPiMock,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: isNativePlatformMock,
  },
}));

describe("settings", () => {
  beforeEach(() => {
    window.localStorage.clear();
    discoverPiMock.mockReset();
    isNativePlatformMock.mockReset();
    isNativePlatformMock.mockReturnValue(false);
    vi.resetModules();
  });

  it("persists settings through the synchronous cache interface", async () => {
    const settings = await import("./settings");

    settings.setSettings({
      ...settings.getSettings(),
      mode: "live",
      serverBaseUrl: "http://projectplant.local:8000",
      activeUserId: "grower-1",
    });

    expect(settings.getSettings()).toMatchObject({
      mode: "live",
      serverBaseUrl: "http://projectplant.local:8000",
      activeUserId: "grower-1",
    });
    expect(settings.getApiBaseUrlSync()).toBe("http://projectplant.local:8000/api/v1");
  });

  it("delegates discovery to the shared sdk wrapper", async () => {
    discoverPiMock.mockResolvedValue({
      host: "10.0.0.50",
      port: 8000,
      serviceType: "_http._tcp",
      via: "native",
    });

    const settings = await import("./settings");
    await expect(settings.discoverServer()).resolves.toEqual({
      host: "10.0.0.50",
      port: 8000,
      via: "native",
    });
  });
});
