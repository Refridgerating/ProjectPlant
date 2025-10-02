import { createMockBackend, mockBackend as createStandaloneMockBackend, type MockBackend, type SensorTelemetry } from "./mock";
import { createMqttClient, type MqttBridge, type MessageHandler } from "./mqtt";
import { createRestClient, type IrrigationZone, type PotSummary, type RestClient } from "./rest";
import { getEnv, setEnv, type RuntimeEnv } from "./env";

export { discoverPi } from "./discover";
export type { PiDiscoveryResult } from "./discover";


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
  const wrapped: MessageHandler = (msgTopic, raw) => {
    if (msgTopic !== topic) {
      return;
    }
    handler({
      topic: msgTopic,
      raw,
      parsed: parseTelemetry(raw),
      origin: "live"
    });
  };
  const dispose = bridge.subscribe(topic, wrapped);
  return async () => {
    dispose();
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
    const parsed = JSON.parse(decoded) as Partial<SensorTelemetry>;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    if (typeof parsed.potId !== "string" || typeof parsed.moisture !== "number") {
      return undefined;
    }
    return {
      potId: parsed.potId,
      moisture: parsed.moisture,
      temperature: typeof parsed.temperature === "number" ? parsed.temperature : 0,
      humidity: typeof parsed.humidity === "number" ? parsed.humidity : undefined,
      valveOpen: typeof parsed.valveOpen === "boolean" ? parsed.valveOpen : false,
      flowRateLpm: typeof parsed.flowRateLpm === "number" ? parsed.flowRateLpm : undefined,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString()
    };
  } catch {
    return undefined;
  }
}
