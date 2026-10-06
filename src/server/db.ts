import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Return numerics and bigints as numbers: amounts fit comfortably, ids too.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// Dates stay ISO strings; JS Dates would shift them by the local zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

/**
 * Connects with DATABASE_URL, or with libpq's PG* variables. PGPASSWORD_FILE is read here,
 * because pg itself only understands PGPASSWORD.
 */
export function createPool(databaseUrl: string | undefined, env = process.env): Db {
  const password = env.PGPASSWORD_FILE ? readFileSync(env.PGPASSWORD_FILE, "utf8").trim() : undefined;
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ...(password ? { password } : {}),
    max: 8,
    idleTimeoutMillis: 30_000,
  });
  // An idle connection dropped by the server (a Postgres restart, say) must not take the
  // process down; the pool replaces it on the next query.
  pool.on("error", (err) => console.warn(`database connection lost: ${err.message}`));
  return pool;
}

export async function inTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The app's root directory (the one holding package.json and migrations/). */
export function appRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "migrations"))) return dir;
    dir = resolve(dir, "..");
  }
  throw new Error("cannot find the app root (package.json + migrations/)");
}

/**
 * Applies `migrations/NNN_name.sql` in order, each in its own transaction, recording them
 * in `schema_migration`. An advisory lock keeps two replicas from migrating at once.
 */
export async function migrate(db: Db, dir = join(appRoot(), "migrations")): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(235235)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migration")).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(235235)").catch(() => undefined);
    client.release();
  }
  return applied;
}
