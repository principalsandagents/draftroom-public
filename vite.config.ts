import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: Vite on 5173 proxies /api to the server on 8790.
// Start: the server serves client/dist itself.
export default defineConfig({
  root: "client",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8790" },
  },
  test: { root: ".", include: ["tests/**/*.test.ts"] },
} as any);
