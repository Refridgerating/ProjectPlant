import { CapacitorConfig } from "@capacitor/cli";

const env = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const isDebugBuild =
  env.BUILD_TYPE === "debug" ||
  env.CAPACITOR_ANDROID_DEBUG === "true" ||
  env.NODE_ENV === "development";

const config: CapacitorConfig = {
  appId: "com.projectplant.app",
  appName: "Project Plant",
  webDir: "../web_ui/dist"
};

if (isDebugBuild) {
  // Live reload endpoint for debug builds only; release builds fall back to bundled assets.
  config.server = {
    url: env.CAPACITOR_ANDROID_DEV_URL ?? "http://192.168.0.8:5173/",
    cleartext: true
  };
}

export default config;
