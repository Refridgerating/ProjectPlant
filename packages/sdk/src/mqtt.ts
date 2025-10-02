import mqtt, { type IClientOptions, type MqttClient as RawMqttClient } from "mqtt";

export type ConnectionState = "connecting" | "connected" | "error" | "offline";
export type MessageHandler = (topic: string, payload: Uint8Array) => void;
export type StateHandler = (state: ConnectionState) => void;

export interface ConnectOptions {
  username?: string;
  password?: string;
  clientId?: string;
}

export type PublishPayload = string | Uint8Array | ArrayBuffer | ArrayBufferView | Record<string, unknown>;

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;

export class MqttClientManager {
  private url: string | null = null;
  private credentials: ConnectOptions = {};
  private client: RawMqttClient | null = null;
  private generation = 0;
  private connecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private state: ConnectionState = "offline";
  private lastError: Error | null = null;
  private pendingConnectResolvers: Array<(value: void) => void> = [];
  private subscriptions = new Map<string, Set<MessageHandler>>();
  private stateListeners = new Set<StateHandler>();
  private boundListeners: {
    connect: () => void;
    error: (error: Error) => void;
    close: () => void;
    offline: () => void;
    end: () => void;
    message: (topic: string, payload: Uint8Array) => void;
  } | null = null;

  async connect(url: string, options: ConnectOptions = {}): Promise<void> {
    if (!url) {
      throw new Error("MQTT url is required");
    }

    const urlChanged = this.url !== null && this.url !== url;
    this.url = url;

    if (options.username !== undefined) {
      this.credentials.username = options.username;
    }
    if (options.password !== undefined) {
      this.credentials.password = options.password;
    }
    if (options.clientId !== undefined) {
      this.credentials.clientId = options.clientId;
    }

    if (!urlChanged && this.state === "connected" && this.client) {
      return;
    }

    if (urlChanged) {
      this.resetConnectionState();
    }

    return new Promise<void>((resolve) => {
      this.pendingConnectResolvers.push(resolve);
      this.startConnection();
    });
  }

  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    this.pendingConnectResolvers = [];
    this.subscriptions.clear();
    this.credentials = {};
    this.lastError = null;
    this.url = null;
    this.reconnectAttempts = 0;
    this.updateState("offline");
    this.teardownClient();
  }

  subscribe(topic: string, handler: MessageHandler): () => void {
    if (!topic) {
      throw new Error("topic is required");
    }
    if (typeof handler !== "function") {
      throw new Error("handler must be a function");
    }

    const firstHandler = !this.subscriptions.has(topic);
    let handlers = this.subscriptions.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(topic, handlers);
    }
    handlers.add(handler);

    if (firstHandler) {
      this.requestSubscription(topic);
    }

    return () => {
      this.removeSubscription(topic, handler);
    };
  }

  unsubscribe(topic: string): void {
    const handlers = this.subscriptions.get(topic);
    if (!handlers) {
      return;
    }
    this.subscriptions.delete(topic);
    if (this.client && this.state === "connected") {
      this.client.unsubscribe(topic, () => undefined);
    }
  }

  async publish(topic: string, payload: PublishPayload): Promise<void> {
    const instance = this.client;
    if (!instance || this.state !== "connected") {
      throw new Error("MQTT client is not connected");
    }
    const buffer = toBuffer(payload);
    await new Promise<void>((resolve, reject) => {
      instance.publish(topic, buffer, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  onState(handler: StateHandler): () => void {
    this.stateListeners.add(handler);
    handler(this.state);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  getLastError(): Error | null {
    return this.lastError;
  }

  private startConnection(): void {
    if (!this.url) {
      throw new Error("connect() must be called with a url before connecting");
    }
    if (this.connecting) {
      return;
    }

    this.connecting = true;
    this.clearReconnectTimer();
    this.teardownClient();

    const generation = ++this.generation;
    this.updateState("connecting");

    const connectionOptions: IClientOptions = {
      reconnectPeriod: 0,
      clean: true,
      ...this.credentials
    };

    let instance: RawMqttClient;
    try {
      instance = mqtt.connect(this.url, connectionOptions);
    } catch (error) {
      this.connecting = false;
      const asError = toError(error);
      this.lastError = asError;
      this.updateState("error");
      this.scheduleReconnect();
      return;
    }

    const handleConnect = () => {
      if (generation !== this.generation) {
        return;
      }
      this.connecting = false;
      this.reconnectAttempts = 0;
      this.lastError = null;
      this.updateState("connected");
      const resolvers = this.pendingConnectResolvers.splice(0);
      resolvers.forEach((resolve) => resolve());
      this.resubscribeAll();
    };

    const handleError = (error: Error) => {
      if (generation !== this.generation) {
        return;
      }
      this.connecting = false;
      this.lastError = error;
      this.updateState("error");
      this.scheduleReconnect();
    };

    const handleClose = () => {
      if (generation !== this.generation) {
        return;
      }
      this.connecting = false;
      if (this.state !== "offline") {
        this.updateState("offline");
      }
      this.scheduleReconnect();
    };

    const handleOffline = () => {
      handleClose();
    };

    const handleMessage = (topic: string, payload: Uint8Array) => {
      if (generation !== this.generation) {
        return;
      }
      this.dispatchMessage(topic, payload);
    };

    instance.on("connect", handleConnect);
    instance.on("error", handleError);
    instance.on("close", handleClose);
    instance.on("offline", handleOffline);
    instance.on("end", handleOffline);
    instance.on("message", handleMessage);

    this.client = instance;
    this.boundListeners = {
      connect: handleConnect,
      error: handleError,
      close: handleClose,
      offline: handleOffline,
      end: handleOffline,
      message: handleMessage
    };
  }

  private resubscribeAll(): void {
    if (!this.client || this.state !== "connected") {
      return;
    }
    for (const topic of this.subscriptions.keys()) {
      this.requestSubscription(topic);
    }
  }

  private requestSubscription(topic: string): void {
    if (!this.client || this.state !== "connected") {
      return;
    }
    this.client.subscribe(topic, (error) => {
      if (error) {
        this.lastError = toError(error);
        this.updateState("error");
      }
    });
  }

  private removeSubscription(topic: string, handler: MessageHandler): void {
    const handlers = this.subscriptions.get(topic);
    if (!handlers) {
      return;
    }
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.subscriptions.delete(topic);
      if (this.client && this.state === "connected") {
        this.client.unsubscribe(topic, () => undefined);
      }
    }
  }

  private dispatchMessage(topic: string, payload: Uint8Array): void {
    const handlers = this.subscriptions.get(topic);
    if (!handlers || handlers.size === 0) {
      return;
    }
    const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    const copy = new Uint8Array(data);
    handlers.forEach((handler) => {
      try {
        handler(topic, copy);
      } catch {
        // Ignore handler failures so other listeners still receive events.
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.url) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.reconnectAttempts - 1), BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startConnection();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private teardownClient(): void {
    if (!this.client) {
      return;
    }
    if (this.boundListeners) {
      const { connect, error, close, offline, end, message } = this.boundListeners;
      this.client.removeListener("connect", connect);
      this.client.removeListener("error", error);
      this.client.removeListener("close", close);
      this.client.removeListener("offline", offline);
      this.client.removeListener("end", end);
      this.client.removeListener("message", message);
      this.boundListeners = null;
    }
    this.client.end(true);
    this.client.removeAllListeners();
    this.client = null;
    this.connecting = false;
  }

  private resetConnectionState(): void {
    this.clearReconnectTimer();
    this.teardownClient();
    this.reconnectAttempts = 0;
    this.connecting = false;
    this.updateState("offline");
  }

  private updateState(next: ConnectionState): void {
    const changed = this.state !== next;
    this.state = next;
    if (changed || next === "error") {
      this.stateListeners.forEach((listener) => listener(this.state));
    }
  }
}

const defaultManager = new MqttClientManager();

export async function connect(url: string, options: ConnectOptions = {}): Promise<void> {
  await defaultManager.connect(url, options);
}

export async function disconnect(): Promise<void> {
  await defaultManager.disconnect();
}

export function subscribe(topic: string, handler: MessageHandler): () => void {
  return defaultManager.subscribe(topic, handler);
}

export function unsubscribe(topic: string): void {
  defaultManager.unsubscribe(topic);
}

export async function publish(topic: string, payload: PublishPayload): Promise<void> {
  await defaultManager.publish(topic, payload);
}

export function onState(handler: StateHandler): () => void {
  return defaultManager.onState(handler);
}

export function getState(): ConnectionState {
  return defaultManager.getState();
}

export function getLastError(): Error | null {
  return defaultManager.getLastError();
}

export type MqttBridgeOptions = ConnectOptions;

export function createMqttClient(url: string, options: MqttBridgeOptions = {}): MqttBridge {
  const manager = new MqttClientManager();
  return {
    connect: () => manager.connect(url, options),
    disconnect: () => manager.disconnect(),
    subscribe: (topic, handler) => manager.subscribe(topic, handler),
    unsubscribe: (topic) => manager.unsubscribe(topic),
    publish: (topic, payload) => manager.publish(topic, payload),
    onState: (handler) => manager.onState(handler),
    getState: () => manager.getState()
  };
}

export interface MqttBridge {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topic: string, handler: MessageHandler): () => void;
  unsubscribe(topic: string): void;
  publish(topic: string, payload: PublishPayload): Promise<void>;
  onState(handler: StateHandler): () => void;
  getState(): ConnectionState;
}

export function toBuffer(payload: PublishPayload): Uint8Array {
  if (payload instanceof Uint8Array) {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return new Uint8Array(payload);
  }
  if (ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  if (typeof payload === "string") {
    return new TextEncoder().encode(payload);
  }
  return new TextEncoder().encode(JSON.stringify(payload ?? {}));
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error("Unknown error");
  }
}
