import { WebPlugin } from "@capacitor/core";
import type { NsdPlugin, ServiceListener, WatchOptions } from "../nsd";

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `watch-${Math.random().toString(16).slice(2)}`;
}

export class NsdWeb extends WebPlugin implements NsdPlugin {
  private readonly watchers = new Map<string, ReturnType<typeof setInterval>>();

  async watch(options: WatchOptions, listener: ServiceListener): Promise<string> {
    const id = generateId();
    const emit = () =>
      listener({
        id: `${options.serviceType}-mock`,
        name: "Mock Plant Gateway",
        type: options.serviceType,
        host: "localhost",
        port: 8080,
        txt: { env: "mock" }
      });

    emit();
    const timer = setInterval(emit, 15000);
    this.watchers.set(id, timer);
    return id;
  }

  async clearWatch(id: string): Promise<void> {
    const timer = this.watchers.get(id);
    if (timer) {
      clearInterval(timer);
      this.watchers.delete(id);
    }
  }
}
