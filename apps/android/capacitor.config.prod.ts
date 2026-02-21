import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.projectplant.app",
  appName: "Project Plant",
  webDir: "../web/dist",
  bundledWebRuntime: false,
  androidScheme: "https"
};

export default config;

