import { describe, expect, it } from "vitest";

import {
  decodeSessionResponse0,
  decodeSessionResponse1,
  decodeWiFiConfigApplyResponse,
  decodeWiFiConfigGetStatusResponse,
  decodeWiFiConfigSetResponse,
  decodeWiFiScanResultResponse,
  decodeWiFiScanStartResponse,
  decodeWiFiScanStatusResponse,
  encodeSessionCommand0,
  encodeSessionCommand1,
  encodeWiFiConfigApply,
  encodeWiFiConfigGetStatus,
  encodeWiFiConfigSet,
  encodeWiFiScanResultRequest,
  encodeWiFiScanStart,
  encodeWiFiScanStatusRequest,
  Security1Session,
} from "../src/provisioning";

describe("sdk provisioning exports", () => {
  it("encodes provisioning commands as byte arrays", () => {
    expect(encodeSessionCommand0(new Uint8Array(32))).toBeInstanceOf(Uint8Array);
    expect(encodeSessionCommand1(new Uint8Array(16))).toBeInstanceOf(Uint8Array);
    expect(encodeWiFiScanStart()).toBeInstanceOf(Uint8Array);
    expect(encodeWiFiScanStatusRequest()).toBeInstanceOf(Uint8Array);
    expect(encodeWiFiScanResultRequest(0, 4)).toBeInstanceOf(Uint8Array);
    expect(encodeWiFiConfigSet("ssid", "password")).toBeInstanceOf(Uint8Array);
    expect(encodeWiFiConfigApply()).toBeInstanceOf(Uint8Array);
    expect(encodeWiFiConfigGetStatus()).toBeInstanceOf(Uint8Array);
  });

  it("fails cleanly when decode payloads are truncated", () => {
    expect(() => decodeSessionResponse0(new Uint8Array())).toThrow();
    expect(() => decodeSessionResponse1(new Uint8Array())).toThrow();
    expect(() => decodeWiFiScanStartResponse(new Uint8Array())).not.toThrow();
    expect(() => decodeWiFiScanStatusResponse(new Uint8Array())).not.toThrow();
    expect(() => decodeWiFiScanResultResponse(new Uint8Array())).not.toThrow();
    expect(() => decodeWiFiConfigSetResponse(new Uint8Array())).not.toThrow();
    expect(() => decodeWiFiConfigApplyResponse(new Uint8Array())).not.toThrow();
    expect(() => decodeWiFiConfigGetStatusResponse(new Uint8Array())).not.toThrow();
  });

  it("round-trips Security1 encryption when X25519 is available", async () => {
    let first: Security1Session;
    try {
      first = await Security1Session.create("pp-1234");
    } catch (error) {
      expect(String(error)).toMatch(/X25519|unavailable/i);
      return;
    }

    const second = await Security1Session.create("pp-1234");
    const random = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    await first.initialise(second.clientPublicKey, random);
    await second.initialise(first.clientPublicKey, random);

    const payload = new TextEncoder().encode("projectplant");
    const encrypted = await first.encrypt(payload);
    const decrypted = await second.decrypt(encrypted);

    expect(Array.from(decrypted)).toEqual(Array.from(payload));
  });
});
