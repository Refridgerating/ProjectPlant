import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionState } from "../src/mqtt";
import { connect, disconnect, getState, onState, publish, subscribe, unsubscribe } from "../src/mqtt";

const { connectMock, mockClients, resetMocks } = vi.hoisted(() => {
  const { EventEmitter } = require("node:events");
  type SubscribeCallback = (error?: Error | null) => void;
  class MockMqttClient extends EventEmitter {
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    publish: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;

    constructor() {
      super();
      this.subscribe = vi.fn((_: string, callback?: SubscribeCallback) => {
        callback?.(null);
      });
      this.unsubscribe = vi.fn((_: string, callback?: () => void) => {
        callback?.();
      });
      this.publish = vi.fn((_: string, __: Uint8Array, callback?: SubscribeCallback) => {
        callback?.(null);
      });
      this.end = vi.fn((_: boolean = false, __?: unknown, callback?: () => void) => {
        callback?.();
      });
    }
  }

  const clients: MockMqttClient[] = [];
  const connect = vi.fn(() => {
    const client = new MockMqttClient();
    clients.push(client);
    return client;
  });

  const reset = () => {
    connect.mockReset();
    clients.length = 0;
    connect.mockImplementation(() => {
      const client = new MockMqttClient();
      clients.push(client);
      return client;
    });
  };

  reset();

  return { connectMock: connect, mockClients: clients, resetMocks: reset };
});

vi.mock("mqtt", () => ({
  default: { connect: connectMock },
  connect: connectMock
}));

function last<T>(input: T[]): T | undefined {
  return input.length ? input[input.length - 1] : undefined;
}

describe("sdk mqtt client", () => {
  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    await disconnect();
  });

  it("reconnects with exponential backoff and reports state", async () => {
    const stateChanges: ConnectionState[] = [];
    const stop = onState((state) => {
      stateChanges.push(state);
    });

    const promise = connect("mqtt://broker.local", { clientId: "test-client" });

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(getState()).toBe("connecting");

    const firstClient = mockClients[0];
    firstClient.emit("connect");
    await promise;

    expect(getState()).toBe("connected");
    expect(stateChanges).toEqual(["offline", "connecting", "connected"]);

    firstClient.emit("close");
    expect(getState()).toBe("offline");

    vi.advanceTimersByTime(1000);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(getState()).toBe("connecting");

    const secondClient = mockClients[1];
    secondClient.emit("connect");
    expect(getState()).toBe("connected");

    secondClient.emit("error", new Error("boom"));
    expect(getState()).toBe("error");
    expect(last(stateChanges)).toBe("error");

    vi.advanceTimersByTime(2000);
    expect(connectMock).toHaveBeenCalledTimes(3);
    expect(getState()).toBe("connecting");

    const thirdClient = mockClients[2];
    thirdClient.emit("connect");
    expect(getState()).toBe("connected");

    thirdClient.emit("close");
    vi.advanceTimersByTime(1000);
    expect(connectMock).toHaveBeenCalledTimes(4);
    stop();
  });

  it("delivers messages, resubscribes on reconnect, and supports unsubscribe", async () => {
    const connectPromise = connect("mqtt://broker.local");
    const firstClient = mockClients[0];
    firstClient.emit("connect");
    await connectPromise;

    const handlerA = vi.fn();
    const handlerB = vi.fn();

    const disposeA = subscribe("sensors/zone1", handlerA);
    const disposeB = subscribe("sensors/zone1", handlerB);

    expect(firstClient.subscribe).toHaveBeenCalledTimes(1);
    expect(firstClient.subscribe).toHaveBeenCalledWith("sensors/zone1", expect.any(Function));

    firstClient.emit("message", "sensors/zone1", new Uint8Array([1, 2, 3]));
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerA.mock.calls[0][1]).toBeInstanceOf(Uint8Array);

    await publish("commands/pump", { start: true });
    expect(firstClient.publish).toHaveBeenCalledWith("commands/pump", expect.any(Uint8Array), expect.any(Function));

    disposeA();
    expect(firstClient.unsubscribe).not.toHaveBeenCalled();

    firstClient.emit("message", "sensors/zone1", new Uint8Array([4]));
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(2);

    firstClient.emit("close");
    vi.advanceTimersByTime(1000);
    const secondClient = mockClients[1];
    secondClient.emit("connect");

    expect(secondClient.subscribe).toHaveBeenCalledWith("sensors/zone1", expect.any(Function));

    secondClient.emit("message", "sensors/zone1", new Uint8Array([5, 6]));
    expect(handlerB).toHaveBeenCalledTimes(3);

    unsubscribe("sensors/zone1");
    expect(secondClient.unsubscribe).toHaveBeenCalledWith("sensors/zone1", expect.any(Function));

    secondClient.emit("message", "sensors/zone1", new Uint8Array([9]));
    expect(handlerB).toHaveBeenCalledTimes(3);

    disposeB();
  });
});
