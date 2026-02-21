import { BleBridge, type BleDevice } from "@native/ble";
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
  type WiFiScanEntry,
  type WiFiStatus,
} from "./protobuf";
import { Security1Session } from "./security1";

const USER_DESCRIPTION_UUID = "00002901-0000-1000-8000-00805f9b34fb";
const REQUIRED_ENDPOINTS = ["prov-session", "prov-config", "proto-ver"] as const;
const OPTIONAL_ENDPOINTS = ["prov-scan", "prov-ctrl", "hub"] as const;

const DEFAULT_SCAN_CHUNK_SIZE = 4;

type EndpointName = (typeof REQUIRED_ENDPOINTS)[number] | (typeof OPTIONAL_ENDPOINTS)[number];

type EndpointRef = {
  serviceUuid: string;
  characteristicUuid: string;
};

export interface ProtocolInfo {
  version: string;
  capabilities: string[];
  raw: string;
}

export interface HubConfigPayload {
  mqttUri?: string;
  hubUrl?: string;
}

export interface HubConfigResponse {
  ok: boolean;
  status: string;
  mqttUri?: string;
  hubUrl?: string;
}

export interface WaitForWifiOptions {
  timeoutMs: number;
  intervalMs?: number;
  onStatus?: (status: WiFiStatus) => void;
}

export interface WaitForWifiResult {
  connected: boolean;
  status: WiFiStatus | null;
}

function normalizeName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\u0000+$/g, "").trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProvDeviceName(name: string | undefined): boolean {
  const normalized = normalizeName(name);
  return normalized.startsWith("prov_") || normalized.startsWith("prov-");
}

function shortUuid(uuid: string): string {
  const normalized = uuid.trim().toLowerCase();
  if (normalized.length < 8) {
    return normalized;
  }
  if (normalized.startsWith("0000") && normalized.endsWith("-0000-1000-8000-00805f9b34fb")) {
    return normalized.slice(4, 8);
  }
  return normalized.slice(0, 8);
}

function preferStrongerSignal(a: WiFiScanEntry, b: WiFiScanEntry): WiFiScanEntry {
  return a.rssi >= b.rssi ? a : b;
}

function sortNetworks(entries: WiFiScanEntry[]): WiFiScanEntry[] {
  return [...entries].sort((left, right) => {
    if (left.rssi !== right.rssi) {
      return right.rssi - left.rssi;
    }
    return left.ssid.localeCompare(right.ssid);
  });
}

export class EspBleProvisioner {
  private endpointRefs = new Map<EndpointName, EndpointRef>();
  private security: Security1Session | null = null;

  static async scanProvisioningDevices(durationMs = 5000): Promise<BleDevice[]> {
    const devices = await BleBridge.scan(undefined, durationMs);
    const filtered = devices.filter((device) => isProvDeviceName(device.name));
    return filtered.length > 0 ? filtered : devices;
  }

  async connect(deviceId: string): Promise<void> {
    await BleBridge.connect(deviceId);
    this.endpointRefs.clear();
    this.security = null;
    await this.discoverEndpointMap();
  }

  async disconnect(): Promise<void> {
    this.endpointRefs.clear();
    this.security = null;
    await BleBridge.disconnect();
  }

  async getProtocolInfo(): Promise<ProtocolInfo> {
    const payload = new TextEncoder().encode("none");
    const response = await this.callEndpoint("proto-ver", payload, false);
    const raw = decodeText(response);

    try {
      const parsed = JSON.parse(raw) as {
        prov?: { ver?: string; cap?: string[] };
      };
      const version = typeof parsed?.prov?.ver === "string" ? parsed.prov.ver : raw;
      const capabilities = Array.isArray(parsed?.prov?.cap)
        ? parsed.prov.cap.filter((value): value is string => typeof value === "string")
        : [];
      return { version, capabilities, raw };
    } catch {
      return { version: raw, capabilities: [], raw };
    }
  }

  async establishSecurity1Session(pop: string): Promise<void> {
    const sec = await Security1Session.create(pop);
    const cmd0 = encodeSessionCommand0(sec.clientPublicKey);
    const resp0 = decodeSessionResponse0(await this.callEndpoint("prov-session", cmd0, false));
    if (resp0.status !== 0) {
      throw new Error(`Session setup failed at command0 (${resp0.status})`);
    }

    await sec.initialise(resp0.devicePublicKey, resp0.deviceRandom);
    const cmd1 = encodeSessionCommand1(await sec.createClientVerifyData());
    const resp1 = decodeSessionResponse1(await this.callEndpoint("prov-session", cmd1, false));
    if (resp1.status !== 0) {
      throw new Error(`Session setup failed at command1 (${resp1.status})`);
    }
    await sec.verifyDevice(resp1.deviceVerifyData);
    this.security = sec;
  }

  async scanWifiNetworks(): Promise<WiFiScanEntry[]> {
    if (!this.hasEndpoint("prov-scan")) {
      return [];
    }

    const startStatus = decodeWiFiScanStartResponse(
      await this.callEndpoint("prov-scan", encodeWiFiScanStart(), true)
    );
    if (startStatus !== 0) {
      throw new Error(`Wi-Fi scan start failed (${startStatus})`);
    }

    let finished = false;
    let resultCount = 0;
    for (let tries = 0; tries < 10; tries += 1) {
      const status = decodeWiFiScanStatusResponse(
        await this.callEndpoint("prov-scan", encodeWiFiScanStatusRequest(), true)
      );
      if (status.status !== 0) {
        throw new Error(`Wi-Fi scan status failed (${status.status})`);
      }
      finished = status.finished;
      resultCount = status.resultCount;
      if (finished) {
        break;
      }
      await delay(500);
    }

    if (!finished) {
      throw new Error("Wi-Fi scan did not complete");
    }

    const networks: WiFiScanEntry[] = [];
    let offset = 0;
    while (offset < resultCount) {
      const count = Math.min(DEFAULT_SCAN_CHUNK_SIZE, resultCount - offset);
      const result = decodeWiFiScanResultResponse(
        await this.callEndpoint(
          "prov-scan",
          encodeWiFiScanResultRequest(offset, count),
          true
        )
      );
      if (result.status !== 0) {
        throw new Error(`Wi-Fi scan result failed (${result.status})`);
      }
      networks.push(...result.entries);
      offset += count;
    }

    const bySsid = new Map<string, WiFiScanEntry>();
    for (const entry of networks) {
      if (!entry.ssid) {
        continue;
      }
      const existing = bySsid.get(entry.ssid);
      bySsid.set(entry.ssid, existing ? preferStrongerSignal(existing, entry) : entry);
    }
    return sortNetworks(Array.from(bySsid.values()));
  }

  async sendHubConfig(payload: HubConfigPayload): Promise<HubConfigResponse | null> {
    if (!this.hasEndpoint("hub")) {
      return null;
    }
    const body: Record<string, string> = {};
    const mqttUri = payload.mqttUri?.trim();
    const hubUrl = payload.hubUrl?.trim();
    if (mqttUri) {
      body.mqttUri = mqttUri;
    }
    if (hubUrl) {
      body.hubUrl = hubUrl;
    }
    if (Object.keys(body).length === 0) {
      return null;
    }

    const response = await this.callEndpoint(
      "hub",
      new TextEncoder().encode(JSON.stringify(body)),
      true
    );
    const text = decodeText(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, status: "invalid_response" };
    }
    const record = parsed as Record<string, unknown>;
    return {
      ok: record.ok === true,
      status: typeof record.status === "string" ? record.status : "unknown",
      mqttUri: typeof record.mqttUri === "string" ? record.mqttUri : undefined,
      hubUrl: typeof record.hubUrl === "string" ? record.hubUrl : undefined,
    };
  }

  async sendWiFiConfig(ssid: string, passphrase: string): Promise<void> {
    const result = decodeWiFiConfigSetResponse(
      await this.callEndpoint("prov-config", encodeWiFiConfigSet(ssid, passphrase), true)
    );
    if (result !== 0) {
      throw new Error(`Set Wi-Fi config failed (${result})`);
    }
  }

  async applyWiFiConfig(): Promise<void> {
    const result = decodeWiFiConfigApplyResponse(
      await this.callEndpoint("prov-config", encodeWiFiConfigApply(), true)
    );
    if (result !== 0) {
      throw new Error(`Apply Wi-Fi config failed (${result})`);
    }
  }

  async fetchWiFiStatus(): Promise<WiFiStatus> {
    const payload = encodeWiFiConfigGetStatus();
    return decodeWiFiConfigGetStatusResponse(
      await this.callEndpoint("prov-config", payload, true)
    );
  }

  async waitForWifiConnection(options: WaitForWifiOptions): Promise<WaitForWifiResult> {
    const timeoutMs = Math.max(options.timeoutMs, 1_000);
    const intervalMs = Math.max(options.intervalMs ?? 2_500, 500);
    const deadline = Date.now() + timeoutMs;
    let latestStatus: WiFiStatus | null = null;

    while (Date.now() <= deadline) {
      const status = await this.fetchWiFiStatus();
      latestStatus = status;
      options.onStatus?.(status);

      if (status.staState === 0) {
        return { connected: true, status };
      }
      if (status.staState === 3) {
        return { connected: false, status };
      }

      await delay(intervalMs);
    }
    return { connected: false, status: latestStatus };
  }

  private hasEndpoint(name: EndpointName): boolean {
    return this.endpointRefs.has(name);
  }

  private requireEndpoint(name: EndpointName): EndpointRef {
    const found = this.endpointRefs.get(name);
    if (!found) {
      throw new Error(`BLE endpoint '${name}' was not discovered`);
    }
    return found;
  }

  private requireSecurity(): Security1Session {
    if (!this.security) {
      throw new Error("Secure session not established");
    }
    return this.security;
  }

  private async callEndpoint(
    endpointName: EndpointName,
    payload: Uint8Array,
    encrypted: boolean
  ): Promise<Uint8Array> {
    const endpoint = this.requireEndpoint(endpointName);
    BleBridge.setActiveService(endpoint.serviceUuid);
    const outbound = encrypted ? await this.requireSecurity().encrypt(payload) : payload;
    await BleBridge.write(endpoint.characteristicUuid, outbound);
    const response = await BleBridge.read(endpoint.characteristicUuid);
    return encrypted ? this.requireSecurity().decrypt(response) : response;
  }

  private async discoverEndpointMap(): Promise<void> {
    this.endpointRefs.clear();
    try {
      await BleBridge.discoverServices();
    } catch {
      // Service discovery often succeeds implicitly on connect; continue.
    }
    const services = await BleBridge.getServices();

    // Preferred path: read characteristic user descriptions (UUID 0x2901).
    for (const service of services) {
      BleBridge.setActiveService(service.uuid);
      for (const characteristic of service.characteristics) {
        const descriptor = characteristic.descriptors.find(
          (entry) => entry.uuid.toLowerCase() === USER_DESCRIPTION_UUID
        );
        if (!descriptor) {
          continue;
        }
        try {
          const value = await BleBridge.readDescriptor(characteristic.uuid, descriptor.uuid);
          const endpointName = normalizeName(decodeText(value)) as EndpointName;
          if (this.isKnownEndpoint(endpointName) && !this.endpointRefs.has(endpointName)) {
            this.endpointRefs.set(endpointName, {
              serviceUuid: service.uuid,
              characteristicUuid: characteristic.uuid,
            });
          }
        } catch {
          // Descriptor reads may fail on some stacks; continue to fallbacks.
        }
      }
    }

    // Fallback for stacks where descriptor reads are unavailable.
    if (!this.hasAllRequiredEndpoints()) {
      const shortToEndpoint = new Map<string, EndpointName>([
        ["ff4f", "prov-ctrl"],
        ["ff50", "prov-scan"],
        ["ff51", "prov-session"],
        ["ff52", "prov-config"],
        ["ff53", "proto-ver"],
        ["ff54", "hub"],
      ]);

      for (const service of services) {
        for (const characteristic of service.characteristics) {
          const maybeEndpoint = shortToEndpoint.get(shortUuid(characteristic.uuid));
          if (!maybeEndpoint || this.endpointRefs.has(maybeEndpoint)) {
            continue;
          }
          this.endpointRefs.set(maybeEndpoint, {
            serviceUuid: service.uuid,
            characteristicUuid: characteristic.uuid,
          });
        }
      }
    }

    if (!this.hasAllRequiredEndpoints()) {
      const found = Array.from(this.endpointRefs.keys()).join(", ") || "none";
      throw new Error(
        `Unable to discover required provisioning endpoints. Found: ${found}`
      );
    }
  }

  private hasAllRequiredEndpoints(): boolean {
    return REQUIRED_ENDPOINTS.every((endpoint) => this.endpointRefs.has(endpoint));
  }

  private isKnownEndpoint(endpointName: string): endpointName is EndpointName {
    return [...REQUIRED_ENDPOINTS, ...OPTIONAL_ENDPOINTS].includes(endpointName as EndpointName);
  }
}
