import type { FastifyBaseLogger } from "fastify";
import { createAdapter } from "./adapters/index.js";
import { buildApp } from "./app.js";
import { seedCategories } from "./categories.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { SyncService } from "./sync.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);
  const applied = await migrate(db);
  await seedCategories(db);
  const adapter = createAdapter(config, db);

  // The sync service logs through Fastify's logger, which exists once the app does.
  let appLog: FastifyBaseLogger | undefined;
  const log = {
    info: (obj: object, msg?: string) => appLog?.info(obj, msg),
    warn: (obj: object, msg?: string) => appLog?.warn(obj, msg),
    error: (obj: object, msg?: string) => appLog?.error(obj, msg),
  };
  const sync = new SyncService(db, adapter, log, {
    intervalMs: config.sync.intervalMs,
    fullIntervalMs: config.sync.fullIntervalMs,
  });
  const app = await buildApp({ config, db, adapter, sync });
  appLog = app.log;

  if (config.auth.devBypass) {
    app.log.warn("DEV_AUTH_BYPASS is on: every request is logged in as a local dev user. Never use this in production.");
  }
  if (config.auth.demo) {
    app.log.warn("DEMO_MODE is on: anyone who reaches this service is logged in, over the sample data.");
  }
  if (applied.length) app.log.info({ applied }, "migrations applied");

  await app.listen({ port: config.port, host: config.host });
  if (config.sync.enabled) sync.start();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await sync.stop();
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
