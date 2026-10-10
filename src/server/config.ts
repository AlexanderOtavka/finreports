import { readFileSync } from "node:fs";
import type { NavLink } from "../shared/api.js";

/**
 * All configuration comes from the environment. Secrets may be given inline (`X`) or as a
 * file (`X_FILE`, e.g. a mounted Kubernetes Secret); the file wins.
 */

/** The value that turns on the dev-only auth bypass. Anything else is refused. */
export const DEV_AUTH_BYPASS_VALUE = "i-understand-this-disables-login";

export interface Config {
  port: number;
  host: string;
  basePath: "/reports";
  backend: "firefly" | "sample";
  databaseUrl: string | undefined;
  firefly: {
    /** In-cluster API base URL. */
    url: string;
    token: string | undefined;
    /** Firefly asks for this many days of history on the first sync. */
    initialSyncDays: number;
  };
  sample: {
    seed: number;
    /** Last day of the generated dataset; defaults to today (UTC). */
    endDate: string | undefined;
  };
  auth: {
    /** True only for local development and smoke tests. */
    devBypass: boolean;
    /** The public demo: everyone is the demo user, on any host, over the sample data only. */
    demo: boolean;
    /** This service's public origin: the OAuth redirect URI is built on it. */
    publicOrigin: string;
    /** Firefly as the browser reaches it: where the user authorizes. */
    fireflyPublicUrl: string;
    /** Firefly as this service reaches it: the code exchange and the user lookup. */
    fireflyInternalUrl: string;
    clientId: string | undefined;
    clientSecret: string | undefined;
    allowedEmails: string[];
    allowedHosts: string[];
    idleTimeoutMs: number;
    absoluteTimeoutMs: number;
    cookieName: string;
  };
  sync: {
    intervalMs: number;
    fullIntervalMs: number;
    enabled: boolean;
  };
  /** Links to other apps, shown in the top bar. */
  navLinks: NavLink[];
  webRoot: string | undefined;
  logLevel: string;
}

type Env = Record<string, string | undefined>;

function secret(env: Env, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  const value = env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got ${raw}`);
  return value;
}

function list(env: Env, name: string, fallback: string): string[] {
  return (env[name] ?? fallback)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * `NAV_LINKS`: a JSON array of `{"label": "…", "url": "…"}`, optionally with
 * `"newTab": true`. A URL is absolute (http or https) or a path on this origin ("/").
 */
function navLinks(env: Env): NavLink[] {
  const raw = env.NAV_LINKS;
  if (!raw || !raw.trim()) return [];
  const shape = 'NAV_LINKS must be a JSON array of {"label", "url"} objects';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(shape);
  }
  if (!Array.isArray(parsed)) throw new Error(shape);
  return parsed.map((item: unknown, i) => {
    const { label, url, newTab } = (item ?? {}) as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim() || label.length > 40) {
      throw new Error(`NAV_LINKS[${i}].label must be a non-empty string of at most 40 characters`);
    }
    const sameOrigin = typeof url === "string" && url.startsWith("/") && !url.startsWith("//");
    let absolute = false;
    if (typeof url === "string" && !sameOrigin) {
      try {
        absolute = ["http:", "https:"].includes(new URL(url).protocol);
      } catch {
        // not a URL
      }
    }
    if (!sameOrigin && !absolute) {
      throw new Error(`NAV_LINKS[${i}].url must be an http(s) URL or a path starting with /, got ${String(url)}`);
    }
    if (newTab !== undefined && typeof newTab !== "boolean") throw new Error(`NAV_LINKS[${i}].newTab must be true or false`);
    return { label: label.trim(), url: url as string, ...(newTab ? { newTab } : {}) };
  });
}

export function loadConfig(env: Env = process.env): Config {
  const backend = env.BACKEND ?? "firefly";
  if (backend !== "firefly" && backend !== "sample") {
    throw new Error(`BACKEND must be "firefly" or "sample", got ${backend}`);
  }

  const bypassRaw = env.DEV_AUTH_BYPASS;
  const devBypass = bypassRaw !== undefined && bypassRaw !== "";
  if (devBypass) {
    if (bypassRaw !== DEV_AUTH_BYPASS_VALUE) {
      throw new Error(`DEV_AUTH_BYPASS must be unset or exactly "${DEV_AUTH_BYPASS_VALUE}"`);
    }
    if (backend === "firefly") {
      throw new Error("DEV_AUTH_BYPASS is refused with BACKEND=firefly: it is for the sample backend only");
    }
    if (env.NODE_ENV === "production") {
      throw new Error("DEV_AUTH_BYPASS is refused with NODE_ENV=production");
    }
  }

  const demo = env.DEMO_MODE === "true";
  if (env.DEMO_MODE !== undefined && env.DEMO_MODE !== "" && !demo) {
    throw new Error(`DEMO_MODE must be unset or "true", got ${env.DEMO_MODE}`);
  }
  if (demo && backend !== "sample") {
    throw new Error("DEMO_MODE is for the sample backend only");
  }

  const trim = (url: string) => url.replace(/\/+$/, "");
  const fireflyUrl = trim(env.FIREFLY_INTERNAL_URL || "http://firefly.firefly.svc.cluster.local");
  // Required for real logins (checked below); local development may leave it to default.
  const publicOrigin = trim(env.PUBLIC_ORIGIN || "http://localhost:8080");
  let publicHost: string;
  try {
    publicHost = new URL(publicOrigin).hostname.toLowerCase();
  } catch {
    throw new Error(`PUBLIC_ORIGIN must be an origin such as https://host, got ${publicOrigin}`);
  }
  const config: Config = {
    port: int(env, "PORT", 8080),
    host: env.HOST ?? "0.0.0.0",
    basePath: "/reports",
    backend,
    databaseUrl: env.DATABASE_URL || undefined,
    firefly: {
      url: fireflyUrl,
      token: secret(env, "FIREFLY_TOKEN"),
      initialSyncDays: int(env, "FIREFLY_INITIAL_SYNC_DAYS", 730),
    },
    sample: {
      seed: int(env, "SAMPLE_SEED", 235),
      endDate: env.SAMPLE_END_DATE || undefined,
    },
    auth: {
      devBypass,
      demo,
      publicOrigin,
      fireflyPublicUrl: trim(env.FIREFLY_PUBLIC_URL || publicOrigin),
      fireflyInternalUrl: fireflyUrl,
      clientId: env.OAUTH_CLIENT_ID || undefined,
      clientSecret: secret(env, "OAUTH_CLIENT_SECRET"),
      allowedEmails: list(env, "ALLOWED_EMAILS", ""),
      allowedHosts: list(env, "ALLOWED_HOSTS", publicHost),
      idleTimeoutMs: int(env, "SESSION_IDLE_MINUTES", 30) * 60_000,
      absoluteTimeoutMs: int(env, "SESSION_ABSOLUTE_HOURS", 8) * 3_600_000,
      cookieName: env.SESSION_COOKIE_NAME ?? "REPORTSSESSION",
    },
    sync: {
      intervalMs: int(env, "SYNC_INTERVAL_SECONDS", 300) * 1000,
      fullIntervalMs: int(env, "FULL_SYNC_INTERVAL_HOURS", 24) * 3_600_000,
      enabled: env.SYNC_ENABLED !== "false",
    },
    navLinks: navLinks(env),
    webRoot: env.WEB_ROOT || undefined,
    logLevel: env.LOG_LEVEL ?? "info",
  };

  if (backend === "firefly" && !config.firefly.token) {
    throw new Error("BACKEND=firefly needs FIREFLY_TOKEN or FIREFLY_TOKEN_FILE");
  }
  if (!devBypass && !demo) {
    if (!config.auth.clientId || !config.auth.clientSecret) {
      throw new Error("Login needs OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET (or OAUTH_CLIENT_SECRET_FILE)");
    }
    if (config.auth.allowedEmails.length === 0) {
      throw new Error("ALLOWED_EMAILS must list at least one Firefly login email");
    }
    if (!env.PUBLIC_ORIGIN) {
      throw new Error("Login needs PUBLIC_ORIGIN, the origin the browser uses, e.g. https://firefly.example.com");
    }
  }
  return config;
}
