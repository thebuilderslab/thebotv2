import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Forward /api/* to the local wrangler dev server during development
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/telegram": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
