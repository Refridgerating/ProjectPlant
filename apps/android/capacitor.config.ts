import { CapacitorConfig } from "@capacitor/cli";

const isDebugBuild =
  process.env.BUILD_TYPE === "debug" ||
  process.env.CAPACITOR_ANDROID_DEBUG === "true" ||
  process.env.NODE_ENV === "development";

const config: CapacitorConfig = {
  appId: "com.projectplant.app",
  appName: "Project Plant",
  webDir: "../ui/dist",
  bundledWebRuntime: false,
  androidScheme: "https"
};

if (isDebugBuild) {
  // Live reload endpoint for debug builds only; release builds fall back to bundled assets.
  config.server = {
    url: process.env.CAPACITOR_ANDROID_DEV_URL ?? "http://192.168.0.8:5173/",
    cleartext: true
  };
}

export default config;
