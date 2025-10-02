import { BleClient } from "@capacitor-community/bluetooth-le";

export interface BleDevice {
  id: string;
  name?: string;
  rssi?: number;
}

export type Unsubscribe = () => Promise<void> | void;

let initialized = false;
let activeDeviceId: string | null = null;
let activeServiceUuid: string | null = null;

async function ensureInit(): Promise<void> {
  if (!initialized) {
    await BleClient.initialize({ androidNeverForLocation: true });
    initialized = true;
  }
}

function toBytes(input: DataView | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  const out = new Uint8Array(input.byteLength);
  for (let i = 0; i < input.byteLength; i++) out[i] = input.getUint8(i);
  return out;
}

export const BleBridge = {
  // Scan for devices. If serviceUuid is provided it is stored as the active service
  // and the scan is filtered by that service when supported. Returns a snapshot.
  async scan(serviceUuid?: string, durationMs = 5000): Promise<BleDevice[]> {
    await ensureInit();
    activeServiceUuid = serviceUuid ?? activeServiceUuid;

    const devices = new Map<string, BleDevice>();

    await BleClient.requestLEScan(
      serviceUuid ? { services: [serviceUuid] } : {},
      (result) => {
        const id = result.device.deviceId;
        const name = result.device.name ?? result.localName ?? undefined;
        const rssi = typeof result.rssi === "number" ? result.rssi : undefined;
        devices.set(id, { id, name, rssi });
      }
    );

    await new Promise((resolve) => setTimeout(resolve, durationMs));
    await BleClient.stopLEScan();
    return Array.from(devices.values());
  },

  async connect(deviceId: string): Promise<void> {
    await ensureInit();
    await BleClient.connect(deviceId);
    activeDeviceId = deviceId;
  },

  async disconnect(): Promise<void> {
    if (activeDeviceId) {
      try {
        await BleClient.disconnect(activeDeviceId);
      } finally {
        activeDeviceId = null;
      }
    }
  },

  setActiveService(serviceUuid: string): void {
    activeServiceUuid = serviceUuid;
  },

  getActiveContext(): { deviceId: string; serviceUuid: string } {
    if (!activeDeviceId || !activeServiceUuid) {
      throw new Error("BLE context not ready: connect device and set service first");
    }
    return { deviceId: activeDeviceId, serviceUuid: activeServiceUuid };
  },

  async read(characteristicUuid: string): Promise<Uint8Array> {
    const { deviceId, serviceUuid } = BleBridge.getActiveContext();
    const value = await BleClient.read(deviceId, serviceUuid, characteristicUuid);
    return toBytes(value);
  },

  async write(characteristicUuid: string, value: Uint8Array): Promise<void> {
    const { deviceId, serviceUuid } = BleBridge.getActiveContext();
    await BleClient.write(deviceId, serviceUuid, characteristicUuid, new DataView(value.buffer));
  },

  async subscribe(characteristicUuid: string, handler: (value: Uint8Array) => void): Promise<Unsubscribe> {
    const { deviceId, serviceUuid } = BleBridge.getActiveContext();
    await BleClient.startNotifications(deviceId, serviceUuid, characteristicUuid, (value) => {
      try {
        handler(toBytes(value));
      } catch (err) {
        console.error("BLE subscribe handler error", err);
      }
    });

    return async () => {
      await BleClient.stopNotifications(deviceId, serviceUuid, characteristicUuid);
    };
  }
};

export type BleApi = typeof BleBridge;
