import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@sdk": path.resolve(__dirname, "../../packages/sdk/src"),
      "@native": path.resolve(__dirname, "../../packages/native-bridge/src"),
      "@projectplant/native-bridge": path.resolve(
        __dirname,
        "../../packages/native-bridge/src"
      )
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, "/");

          if (normalized.includes("node_modules")) {
            if (normalized.includes("react")) {
              return "vendor-react";
            }
            if (normalized.includes("mqtt")) {
              return "vendor-mqtt";
            }
            if (normalized.includes("@capacitor")) {
              return "vendor-capacitor";
            }
          }

          if (normalized.includes("packages/sdk/src")) {
            return "sdk";
          }

          return undefined;
        }
      }
    }
  }
});
