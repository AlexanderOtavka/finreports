import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA lives under /reports/, served by the same Node service in production. In
// development, `npm run dev` proxies the API to a server started with `npm run dev:server`.
export default defineConfig({
  root: "src/web",
  base: "/reports/",
  publicDir: "public",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  server: {
    proxy: {
      "/reports/api": "http://localhost:8080",
      "/reports/auth": "http://localhost:8080",
      "/reports/-": "http://localhost:8080",
    },
  },
});
