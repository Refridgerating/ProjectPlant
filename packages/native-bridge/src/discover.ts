import { registerPlugin } from "@capacitor/core";

export const PROJECTPLANT_SERVICE_TYPES = ["_projectplant._tcp", "_http._tcp"] as const;
export const DEFAULT_DISCOVERY_HOST = "projectplant.local";
export const DEFAULT_DISCOVERY_PORTS = [80, 8080];
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

export type ServiceType = (typeof PROJECTPLANT_SERVICE_TYPES)[number];

export interface DiscoverOptions {
  serviceTypes?: string[];
  timeoutMs?: number;
  hostname?: string;
  ports?: number[];
}

export interface DiscoverResult {
  host: string;
  port: number;
  serviceType: string;
}

export interface DiscoverPlugin {
  discover(options?: DiscoverOptions): Promise<DiscoverResult | null>;
}

export const DiscoverBridge = registerPlugin<DiscoverPlugin>("DiscoverBridge", {
  web: () => import("./web/discover").then((m) => new m.DiscoverWeb())
});
