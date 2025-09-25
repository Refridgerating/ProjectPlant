import { defineConfig } from \"vite\";
import react from \"@vitejs/plugin-react\";

export default defineConfig({
  plugins: [react()],
  server: {
    host: \"127.0.0.1\",
    port: 5173,
    proxy: {
      \"/api\": {
        target: \"http://127.0.0.1:8000\",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: \"127.0.0.1\",
    port: 4173,
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes(\"node_modules\")) {
            if (id.includes(\"react-leaflet\") || id.includes(\"leaflet\")) {
              return \"map\";
            }
            if (id.includes(\"recharts\")) {
              return \"charts\";
            }
            if (id.includes(\"@headlessui\") || id.includes(\"@heroicons\")) {
              return \"ui-toolkit\";
            }
            return \"vendor\";
          }
        },
      },
    },
  },
});
