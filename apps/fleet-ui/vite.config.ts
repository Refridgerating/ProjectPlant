import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const strictPort = process.env.PROJECTPLANT_STRICT_PORTS === "1";

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, host: "0.0.0.0", strictPort },
});
