import type { IrrigationZone, PotSummary } from "./rest";
import { sensorTopic, parseSensorTopic } from "./topics";

export interface SensorTelemetry {
  potId: string;
  moisture: number;
  temperature: number;
  humidity?: number;
  valveOpen: boolean;
  flowRateLpm?: number;
  timestamp: string;
}

export type SensorCallback = (payload: SensorTelemetry) => void;

export interface MockBackendOptions {
  potCount?: number;
  intervalMs?: number;
}

export interface MockBackend {
  listPots(): Promise<PotSummary[]>;
  listZones(): Promise<IrrigationZone[]>;
  subscribeSensor(topic: string, handler: SensorCallback): () => void;
  shutdown(): void;
}

export interface MockPlantStreamOptions {
  id: string;
  name?: string;
  intervalMs?: number;
}

export interface MockPlantSnapshot {
  id: string;
  name: string;
  moisture: number;
  temperature: number;
  humidity?: number;
  battery: number;
  updatedAt: string;
}

export interface MockPlantStream {
  stop(): void;
}

interface PotState {
  id: string;
  name: string;
  zoneId: string;
  moisture: number;
  temperature: number;
  humidity: number;
  valveOpen: boolean;
  flowRateLpm: number;
  battery: number;
  updatedAt: string;
}

export function createMockBackend(options: MockBackendOptions = {}): MockBackend {
  const potCount = Math.max(1, Math.round(options.potCount ?? 3));
  const intervalMs = options.intervalMs ?? 2000;

  const zones = [
    { id: "zone-1", name: "Irrigation Loop Alpha" },
    { id: "zone-2", name: "Irrigation Loop Beta" }
  ];

  const pots: PotState[] = Array.from({ length: potCount }, (_, index) => {
    const id = `pot-${index + 1}`;
    const zone = zones[index % zones.length];
    const now = new Date().toISOString();
    const baseMoisture = 48 + index * 3;
    const baseTemp = 22 + (index % 2 === 0 ? 0 : 1.2);
    const baseHumidity = 55 + index * 4;
    return {
      id,
      name: `Demo Plant ${index + 1}`,
      zoneId: zone.id,
      moisture: clamp(baseMoisture, 30, 75),
      temperature: clamp(baseTemp, 19, 30),
      humidity: clamp(baseHumidity, 45, 85),
      valveOpen: index % zones.length === 0,
      flowRateLpm: index % zones.length === 0 ? 1.1 : 0,
      battery: 94 - index * 3,
      updatedAt: now
    };
  });

  const listeners = new Map<string, Set<SensorCallback>>();
  const zoneState = new Map<string, { isActive: boolean; targetFlow: number }>();
  zones.forEach((zone, index) => {
    zoneState.set(zone.id, {
      isActive: index === 0,
      targetFlow: index === 0 ? 1.2 : 0
    });
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let tickCount = 0;

  const update = () => {
    tickCount += 1;
    const timestamp = new Date().toISOString();

    zones.forEach((zone, zoneIndex) => {
      const state = zoneState.get(zone.id)!;
      const active = ((tickCount + zoneIndex) % 4) < 2;
      state.isActive = active;
      state.targetFlow = active ? 0.8 + Math.random() * 0.8 : 0;
    });

    pots.forEach((pot, potIndex) => {
      const zone = zoneState.get(pot.zoneId)!;
      pot.moisture = randomWalk(pot.moisture, 25, 80, 4.5);
      pot.temperature = randomWalk(pot.temperature, 18, 30, 1.3);
      pot.humidity = randomWalk(pot.humidity, 40, 88, 5.5);
      pot.valveOpen = zone.isActive;
      pot.flowRateLpm = zone.isActive ? randomWalk(zone.targetFlow, 0.4, 2.4, 0.35) : 0;
      pot.battery = clamp(pot.battery - 0.08 - (potIndex % 2 === 0 ? 0.02 : 0), 20, 100);
      pot.updatedAt = timestamp;
      emitTelemetry(listeners, pot);
    });
  };

  update();
  timer = setInterval(update, intervalMs);

  function ensureTopic(topic: string, handler: SensorCallback): void {
    const potId = parseSensorTopic(topic);
    if (!potId) {
      throw new Error(`Unsupported sensor topic: ${topic}`);
    }
    if (!listeners.has(topic)) {
      listeners.set(topic, new Set());
    }
    const set = listeners.get(topic)!;
    set.add(handler);
    const pot = pots.find((item) => item.id === potId);
    if (pot) {
      handler(createPayload(pot));
    }
  }

  function unsubscribe(topic: string, handler: SensorCallback) {
    const set = listeners.get(topic);
    if (!set) {
      return;
    }
    set.delete(handler);
    if (set.size === 0) {
      listeners.delete(topic);
    }
  }

  return {
    async listPots() {
      return pots.map((pot) => ({
        id: pot.id,
        name: pot.name,
        soilMoisture: round(pot.moisture, 1),
        temperature: round(pot.temperature, 1),
        humidity: round(pot.humidity, 1),
        battery: round(pot.battery, 1),
        updatedAt: pot.updatedAt
      }));
    },
    async listZones() {
      return zones.map((zone) => {
        const zonePots = pots.filter((pot) => pot.zoneId === zone.id);
        return {
          id: zone.id,
          name: zone.name,
          valves: zonePots.map((pot) => ({
            id: `${zone.id}-valve-${pot.id}`,
            potId: pot.id,
            isOpen: pot.valveOpen,
            flowRateLpm: round(pot.flowRateLpm, 2)
          }))
        } satisfies IrrigationZone;
      });
    },
    subscribeSensor(topic, handler) {
      ensureTopic(topic, handler);
      return () => unsubscribe(topic, handler);
    },
    shutdown() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      listeners.clear();
    }
  };
}

export function mockBackend(options?: MockBackendOptions): MockBackend {
  return createMockBackend(options);
}

export function createMockPlantStream(
  options: MockPlantStreamOptions,
  handler: (snapshot: MockPlantSnapshot) => void
): MockPlantStream {
  const id = options.id;
  const name = options.name ?? formatPlantName(id);
  const intervalMs = options.intervalMs ?? 2000;

  let t = 0;
  let moisture = 42;
  let temperature = 22;
  let humidity = 57;
  let battery = 100;

  const emit = () => {
    const wave = Math.sin(t / 3);
    const drift = Math.cos(t / 9) * 4;
    moisture = clamp(moisture + wave * 1.5 + drift * 0.1, 5, 95);
    temperature = clamp(temperature + wave * 0.7 + Math.sin(t / 5) * 0.4, 10, 35);
    humidity = clamp(humidity + (Math.random() - 0.5) * 6, 35, 90);
    battery = clamp(battery - Math.abs(wave) * 0.3 - 0.05, 5, 100);
    const snapshot: MockPlantSnapshot = {
      id,
      name,
      moisture: round(moisture, 1),
      temperature: round(temperature, 1),
      humidity: round(humidity, 1),
      battery: round(battery, 1),
      updatedAt: new Date().toISOString()
    };
    handler(snapshot);
    t += 1;
  };

  emit();
  const timer: ReturnType<typeof setInterval> = setInterval(emit, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    }
  };
}

function formatPlantName(id: string): string {
  const segments = id.split(/[-_]/).filter(Boolean);
  if (segments.length === 0) {
    return "Demo Plant";
  }
  return segments
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function emitTelemetry(listeners: Map<string, Set<SensorCallback>>, pot: PotState) {
  const topic = sensorTopic(pot.id);
  const payload = createPayload(pot);
  const handlers = listeners.get(topic);
  if (!handlers) {
    return;
  }
  handlers.forEach((handler) => handler(payload));
}

function createPayload(pot: PotState): SensorTelemetry {
  return {
    potId: pot.id,
    moisture: round(pot.moisture, 1),
    temperature: round(pot.temperature, 1),
    humidity: round(pot.humidity, 1),
    valveOpen: pot.valveOpen,
    flowRateLpm: round(pot.flowRateLpm, 2),
    timestamp: pot.updatedAt
  };
}

function randomWalk(value: number, min: number, max: number, step: number): number {
  const delta = (Math.random() - 0.5) * 2 * step;
  return clamp(value + delta, min, max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round(value: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}
