import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SampleAdapter } from "../src/server/adapters/sample.js";
import { buildApp } from "../src/server/app.js";
import { DEV_AUTH_BYPASS_VALUE, loadConfig } from "../src/server/config.js";
import { SyncService } from "../src/server/sync.js";
import { freshDb, silentLog } from "./helpers.js";

describe("web app", async () => {
  const db = await freshDb();
  // Like the Nix store: every mtime is 1970, so only size could tell two builds apart.
  const webRoot = mkdtempSync(join(tmpdir(), "finreports-web-"));
  mkdirSync(join(webRoot, "assets"));
  const index = join(webRoot, "index.html");
  const build = (hash: string) => {
    writeFileSync(index, `<script type="module" src="/reports/assets/index-${hash}.js"></script>`);
    writeFileSync(join(webRoot, "assets", `index-${hash}.js`), "");
    utimesSync(index, 1, 1);
  };
  build("AAAAAAAA");
  afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

  const config = loadConfig({
    BACKEND: "sample",
    DEV_AUTH_BYPASS: DEV_AUTH_BYPASS_VALUE,
    WEB_ROOT: webRoot,
    LOG_LEVEL: "silent",
  });
  const adapter = new SampleAdapter(db, { seed: 235, endDate: "2026-09-30" });
  const sync = new SyncService(db, adapter, silentLog, { intervalMs: 1000, fullIntervalMs: 86_400_000 });
  const app = await buildApp({ config, db, adapter, sync });
  afterAll(() => app.close());
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers: { host: "localhost", ...headers } });

  it("serves a new index.html of the same size instead of a 304 for the old one", async () => {
    const first = await get("/reports/");
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-cache");
    expect(first.headers.etag).toBeUndefined();
    expect(first.headers["last-modified"]).toBeUndefined();

    build("BBBBBBBB");
    const again = await get("/reports/", {
      "if-none-match": 'W/"0-0"',
      "if-modified-since": new Date(0).toUTCString(),
    });
    expect(again.statusCode).toBe(200);
    expect(again.body).toContain("index-BBBBBBBB.js");
  });

  it("lets browsers keep fingerprinted assets", async () => {
    const res = await get("/reports/assets/index-AAAAAAAA.js");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });
});
