/**
 * Gives the tests a PostgreSQL server: TEST_DATABASE_URL if set (CI uses a service
 * container), otherwise a throwaway cluster started with initdb/pg_ctl from PATH, e.g.
 * `nix develop -c npm test`. Each test file creates its own database.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export default async function setup(project: TestProject): Promise<() => void> {
  if (process.env.TEST_DATABASE_URL) {
    project.provide("pgAdminUrl", process.env.TEST_DATABASE_URL);
    return () => undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), "finreports-pg-"));
  const data = join(dir, "data");
  const port = await freePort();
  try {
    execFileSync("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "--no-sync", "-E", "UTF8"], { stdio: "ignore" });
  } catch (err) {
    throw new Error(
      "Tests need PostgreSQL: set TEST_DATABASE_URL, or run with initdb/pg_ctl on PATH " +
        "(nix develop -c npm test). " +
        (err as Error).message,
    );
  }
  execFileSync(
    "pg_ctl",
    ["-D", data, "-l", join(dir, "log"), "-o", `-k ${dir} -p ${port} -h 127.0.0.1 -c fsync=off -c full_page_writes=off`, "-w", "start"],
    { stdio: "ignore" },
  );
  project.provide("pgAdminUrl", `postgresql://postgres@127.0.0.1:${port}/postgres`);
  return () => {
    try {
      execFileSync("pg_ctl", ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
