import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const hubProxyTarget = (process.env.PROJECTPLANT_HUB_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const strictPort = process.env.PROJECTPLANT_STRICT_PORTS === "1";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@native": path.resolve(__dirname, "../../packages/native-bridge/src"),
      "@projectplant/native-bridge": path.resolve(__dirname, "../../packages/native-bridge/src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort,
    proxy: {
      "/api": {
        target: hubProxyTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react-leaflet") || id.includes("leaflet")) {
              return "map";
            }
            if (id.includes("recharts")) {
              return "charts";
            }
            if (id.includes("@headlessui") || id.includes("@heroicons")) {
              return "ui-toolkit";
            }
            return "vendor";
          }
        },
      },
    },
  },
});
