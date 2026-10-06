import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, inject } from "vitest";
import { seedCategories } from "../src/server/categories.js";
import { createPool, migrate, type Db } from "../src/server/db.js";

/** A new, migrated, seeded database for this test file; dropped afterwards. */
export async function freshDb(options: { seed?: boolean } = {}): Promise<Db> {
  const adminUrl = inject("pgAdminUrl");
  const name = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = createPool(url.toString(), {});
  await migrate(db);
  if (options.seed !== false) await seedCategories(db);
  afterAll(async () => {
    await db.end();
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  });
  return db;
}

export const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
