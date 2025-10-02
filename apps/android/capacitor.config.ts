﻿import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.projectplant.app",
  appName: "Project Plant",
  webDir: "../web/dist",
  bundledWebRuntime: false,
  server: {
    androidScheme: "https"
  }
};

export default config;
