import { registerPlugin } from "@capacitor/core";

export interface NsdService {
  id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  txt?: Record<string, string>;
}

export interface WatchOptions {
  serviceType: string;
}

export type ServiceListener = (service: NsdService) => void;

export interface NsdPlugin {
  watch(options: WatchOptions, listener: ServiceListener): Promise<string>;
  clearWatch(id: string): Promise<void>;
}

export const NsdBridge = registerPlugin<NsdPlugin>("NsdBridge", {
  web: () => import("./web/nsd").then((m) => new m.NsdWeb())
});
