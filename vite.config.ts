import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The placeholder in sw.ts, in whichever quotes the minifier picks. */
const SW_MANIFEST = /(["'`])__SW_MANIFEST__\1/;

/**
 * The service worker (src/sw/sw.ts) is built as its own entry at /reports/sw.js. Once
 * everything is written, its placeholder becomes the list of this build's files (the bundle
 * and the public dir, without source maps) and a hash of their contents.
 */
function serviceWorker(): Plugin {
  return {
    name: "finreports-sw",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir!;
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split("\\").join("/"))
        .filter((f) => f !== "sw.js" && !f.endsWith(".map"))
        .sort();
      const hash = createHash("sha256");
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const swPath = join(outDir, "sw.js");
      const sw = readFileSync(swPath, "utf8");
      if (!SW_MANIFEST.test(sw)) throw new Error("sw.js has no manifest placeholder");
      const manifest = JSON.stringify({ version: hash.digest("hex").slice(0, 16), files });
      writeFileSync(swPath, sw.replace(SW_MANIFEST, () => JSON.stringify(manifest)));
    },
  };
}

// The SPA lives under /reports/, served by the same Node service in production. In
// development, `npm run dev` proxies the API to a server started with `npm run dev:server`.
export default defineConfig({
  root: "src/web",
  base: "/reports/",
  publicDir: "public",
  plugins: [react(), serviceWorker()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: { index: resolve(import.meta.dirname, "src/web/index.html"), sw: resolve(import.meta.dirname, "src/sw/sw.ts") },
      output: { entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") },
    },
  },
  server: {
    proxy: {
      "/reports/api": "http://localhost:8080",
      "/reports/auth": "http://localhost:8080",
      "/reports/-": "http://localhost:8080",
    },
  },
});
