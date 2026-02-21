import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.projectplant.app",
  appName: "Project Plant",
  webDir: "../web/dist",
  bundledWebRuntime: false,
  server: {
    url: "http://192.168.0.8:5173/",
    cleartext: true
  },
  androidScheme: "https"
};

export default config;

