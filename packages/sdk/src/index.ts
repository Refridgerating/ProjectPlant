import { createMockBackend, mockBackend as createStandaloneMockBackend, type MockBackend, type SensorTelemetry } from "./mock";
import { createMqttClient, type MqttBridge, type MessageHandler } from "./mqtt";
import { createRestClient, type IrrigationZone, type PotSummary, type RestClient } from "./rest";
import { getEnv, setEnv, type RuntimeEnv } from "./env";
import { parseSensorTopic, legacyTelemetryTopic } from "./topics";

export { discoverPi } from "./discover";
export type { PiDiscoveryResult } from "./discover";
export * from "./topics";


export interface SensorEvent {
  topic: string;
  raw: Uint8Array;
  parsed?: SensorTelemetry;
  origin: "mock" | "live";
}

export type SensorEventHandler = (event: SensorEvent) => void;

let restClient: RestClient | null = null;
let mqttBridge: MqttBridge | null = null;
let mock: MockBackend | null = null;

export async function connect(config: RuntimeEnv): Promise<void> {
  await setEnv(config);
  await initializeFromEnv();
}

export async function listPots(): Promise<PotSummary[]> {
  const env = await getEnv();
  if (env.mode === "demo") {
    const backend = ensureMockBackend();
    return backend.listPots();
  }
  const client = ensureRestClient(env);
  return client.listPots();
}

export async function listZones(): Promise<IrrigationZone[]> {
  const env = await getEnv();
  if (env.mode === "demo") {
    const backend = ensureMockBackend();
    return backend.listZones();
  }
  const client = ensureRestClient(env);
  return client.listZones();
}

export async function subscribeSensor(topic: string, handler: SensorEventHandler): Promise<() => void> {
  const env = await getEnv();
  if (env.mode === "demo") {
    const backend = ensureMockBackend();
    const unsubscribe = backend.subscribeSensor(topic, (payload) => {
      handler({
        topic,
        parsed: payload,
        raw: encodePayload(payload),
        origin: "mock"
      });
    });
    return async () => {
      unsubscribe();
    };
  }

  if (!env.mqttUrl) {
    throw new Error("mqttUrl is required to subscribe in live mode");
  }

  const bridge = ensureMqttBridge(env);
  await bridge.connect();
  // Map requested SDK topic to one or more broker topics.
  const { topics: brokerTopics, potId } = mapSensorTopic(topic);

  const expected = new Set(brokerTopics);
  const disposers: Array<() => void> = [];
  const wrapped: MessageHandler = (msgTopic, raw) => {
    if (!expected.has(msgTopic)) {
      return;
    }
    const parsed = parseTelemetry(raw) ?? parseFirmwareTelemetry(raw, potId);
    handler({
      // Normalize the exposed topic to the requested SDK topic
      topic,
      raw,
      parsed,
      origin: "live"
    });
  };

  // Subscribe to each mapped broker topic.
  for (const t of brokerTopics) {
    disposers.push(bridge.subscribe(t, wrapped));
  }

  return async () => {
    disposers.forEach((d) => d());
  };
}

export function mockBackend(options?: Parameters<typeof createMockBackend>[0]): MockBackend {
  return createStandaloneMockBackend(options);
}

async function initializeFromEnv(): Promise<void> {
  const env = await getEnv();
  if (env.mode === "demo") {
    teardownLiveClients();
    if (!mock) {
      mock = createMockBackend();
    }
    return;
  }

  if (!env.baseUrl) {
    throw new Error("baseUrl is required for live mode");
  }

  mock?.shutdown();
  mock = null;
  restClient = createRestClient(env.baseUrl);

  if (env.mqttUrl) {
    mqttBridge = createMqttClient(env.mqttUrl);
  } else {
    mqttBridge = null;
  }
}

function ensureRestClient(env: RuntimeEnv): RestClient {
  if (!env.baseUrl) {
    throw new Error("baseUrl is required for REST calls in live mode");
  }
  if (!restClient) {
    restClient = createRestClient(env.baseUrl);
  }
  return restClient;
}

function ensureMqttBridge(env: RuntimeEnv): MqttBridge {
  if (!env.mqttUrl) {
    throw new Error("mqttUrl is required for MQTT in live mode");
  }
  if (!mqttBridge) {
    mqttBridge = createMqttClient(env.mqttUrl);
  }
  return mqttBridge;
}

function ensureMockBackend(): MockBackend {
  if (!mock) {
    mock = createMockBackend();
  }
  return mock;
}

function teardownLiveClients() {
  restClient = null;
  if (mqttBridge) {
    void mqttBridge.disconnect();
    mqttBridge = null;
  }
}

function encodePayload(payload: SensorTelemetry): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function parseTelemetry(buffer: Uint8Array): SensorTelemetry | undefined {
  try {
    const decoded = new TextDecoder().decode(buffer);
    const obj = JSON.parse(decoded) as Record<string, unknown> | null;
    if (!obj || typeof obj !== "object") return undefined;

    // Direct SDK schema
    if (
      typeof obj["potId"] === "string" &&
      typeof obj["moisture"] === "number"
    ) {
      return {
        potId: obj["potId"] as string,
        moisture: obj["moisture"] as number,
        temperature: typeof obj["temperature"] === "number" ? (obj["temperature"] as number) : 0,
        humidity: typeof obj["humidity"] === "number" ? (obj["humidity"] as number) : undefined,
        valveOpen: typeof obj["valveOpen"] === "boolean" ? (obj["valveOpen"] as boolean) : false,
        flowRateLpm: typeof obj["flowRateLpm"] === "number" ? (obj["flowRateLpm"] as number) : undefined,
        timestamp: typeof obj["timestamp"] === "string" ? (obj["timestamp"] as string) : new Date().toISOString()
      } satisfies SensorTelemetry;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// Parse firmware JSON published at legacy firmware topics (projectplant/pots/<id>/telemetry)
function parseFirmwareTelemetry(buffer: Uint8Array, fallbackPotId?: string): SensorTelemetry | undefined {
  try {
    const decoded = new TextDecoder().decode(buffer);
    const obj = JSON.parse(decoded) as Record<string, unknown> | null;
    if (!obj || typeof obj !== "object") return undefined;

    const deviceId = typeof obj["device_id"] === "string" ? (obj["device_id"] as string) : fallbackPotId;
    const soilPct = typeof obj["soil_pct"] === "number" ? (obj["soil_pct"] as number) : undefined;
    const temperatureC = typeof obj["temperature_c"] === "number" ? (obj["temperature_c"] as number) : undefined;
    const humidityPct = typeof obj["humidity_pct"] === "number" ? (obj["humidity_pct"] as number) : undefined;
    const pumpOn = typeof obj["pump_on"] === "boolean" ? (obj["pump_on"] as boolean) : undefined;
    const tsMs = typeof obj["timestamp_ms"] === "number" ? (obj["timestamp_ms"] as number) : undefined;

    if (!deviceId) return undefined;
    if (soilPct === undefined && temperatureC === undefined && humidityPct === undefined && pumpOn === undefined) {
      // Not a telemetry payload we understand
      return undefined;
    }

    const isoTs = tsMs !== undefined ? new Date(tsMs).toISOString() : new Date().toISOString();
    return {
      potId: deviceId,
      moisture: soilPct ?? 0,
      temperature: temperatureC ?? 0,
      humidity: humidityPct,
      valveOpen: pumpOn ?? false,
      flowRateLpm: undefined,
      timestamp: isoTs
    } satisfies SensorTelemetry;
  } catch {
    return undefined;
  }
}

// Map SDK topic aliases to broker topics and extract pot id when possible
function mapSensorTopic(requested: string): { topics: string[]; potId?: string } {
  const potId = parseSensorTopic(requested);
  if (!potId) {
    return { topics: [requested] };
  }

  const topics = Array.from(new Set([legacyTelemetryTopic(potId), requested]));
  return { topics, potId };
}
