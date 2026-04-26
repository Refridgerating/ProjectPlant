import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.projectplant.app",
  appName: "Project Plant",
  webDir: "../web_ui/dist",
  server: {
    url: "http://192.168.0.8:5173/",
    cleartext: true
  }
};

export default config;

