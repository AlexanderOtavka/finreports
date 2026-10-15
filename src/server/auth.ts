import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db.js";

/**
 * Login with Firefly, as the Bank links dashboard does (cluster/firefly/README.md,
 * "Authentication and the shared origin"):
 *
 * - a confidential OAuth client of Firefly's Laravel Passport: the browser authorizes at the
 *   public URL, the server exchanges the code (with PKCE) at the in-cluster URL and reads
 *   `/api/v1/about/user`;
 * - only an unblocked `owner` whose email is allowed gets in; the Firefly token is dropped
 *   after that one call;
 * - the session cookie is `Path=/reports; Secure; HttpOnly; SameSite=Lax`, sessions end
 *   after an idle and an absolute timeout, CSRF tokens live in the server-side session
 *   (Laravel owns `XSRF-TOKEN` at `/`), requests for other hosts are refused, and the CSP
 *   allows only this origin.
 *
 * DEV_AUTH_BYPASS replaces all of it with a fixed local user; config.ts refuses it with the
 * Firefly backend or NODE_ENV=production. DEMO_MODE does the same for the public demo, on any
 * host and in production, and config.ts refuses it with any backend but the sample one.
 */

declare module "fastify" {
  interface FastifyRequest {
    user?: { email: string; csrfToken: string };
  }
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const BASE = "/reports";
const OAUTH_COOKIE = "REPORTSOAUTH";
const MISDIRECTED_REQUEST = 421;

/** Reachable without a login. Static assets carry no data. */
const PUBLIC_PREFIXES = [`${BASE}/-/`, `${BASE}/auth/`, `${BASE}/assets/`, `${BASE}/icons/`];
const PUBLIC_EXACT = new Set([`${BASE}/manifest.webmanifest`, `${BASE}/favicon.svg`]);

export interface FireflyUser {
  id: string | null;
  email: string | null;
  role: string | null;
  blocked: boolean;
}

/** Firefly answers in JSON:API; a missing `blocked` counts as blocked (fail closed). */
export function parseFireflyUser(body: unknown): FireflyUser {
  const data = (body as { data?: { id?: unknown; attributes?: Record<string, unknown> } })?.data;
  const a = data?.attributes ?? {};
  return {
    id: typeof data?.id === "string" ? data.id : data?.id != null ? String(data.id) : null,
    email: typeof a.email === "string" ? a.email : null,
    role: typeof a.role === "string" ? a.role : null,
    blocked: typeof a.blocked === "boolean" ? a.blocked : true,
  };
}

export function isAllowed(user: FireflyUser, allowedEmails: string[]): boolean {
  return (
    user.role === "owner" &&
    !user.blocked &&
    user.email !== null &&
    allowedEmails.some((e) => e.toLowerCase() === user.email!.toLowerCase())
  );
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // ignore malformed values
    }
  }
  return out;
}

function cookie(name: string, value: string, opts: { path: string; maxAge?: number }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`, "Secure", "HttpOnly", "SameSite=Lax"];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const token = (bytes = 32): string => randomBytes(bytes).toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Sessions {
  constructor(
    private readonly db: Db,
    private readonly idleMs: number,
    private readonly absoluteMs: number,
  ) {}

  async create(email: string): Promise<{ id: string; csrfToken: string }> {
    const id = token();
    const csrfToken = token();
    await this.db.query("INSERT INTO web_session (id_hash, email, csrf_token) VALUES ($1, $2, $3)", [sha256(id), email, csrfToken]);
    // Opportunistic cleanup of expired sessions.
    await this.db.query(
      "DELETE FROM web_session WHERE last_seen_at < now() - make_interval(secs => $1) OR created_at < now() - make_interval(secs => $2)",
      [this.idleMs / 1000, this.absoluteMs / 1000],
    );
    return { id, csrfToken };
  }

  async get(id: string): Promise<{ email: string; csrfToken: string } | null> {
    const res = await this.db.query<{ email: string; csrf_token: string; created_at: Date; last_seen_at: Date }>(
      "SELECT email, csrf_token, created_at, last_seen_at FROM web_session WHERE id_hash = $1",
      [sha256(id)],
    );
    const row = res.rows[0];
    if (!row) return null;
    const now = Date.now();
    if (now - row.last_seen_at.getTime() > this.idleMs || now - row.created_at.getTime() > this.absoluteMs) {
      await this.destroy(id);
      return null;
    }
    if (now - row.last_seen_at.getTime() > 60_000) {
      await this.db.query("UPDATE web_session SET last_seen_at = now() WHERE id_hash = $1", [sha256(id)]);
    }
    return { email: row.email, csrfToken: row.csrf_token };
  }

  async destroy(id: string): Promise<void> {
    await this.db.query("DELETE FROM web_session WHERE id_hash = $1", [sha256(id)]);
  }
}

interface PendingLogin {
  verifier: string;
  next: string;
  expires: number;
}

function isPublic(path: string): boolean {
  return PUBLIC_EXACT.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

function safeNext(next: unknown): string {
  return typeof next === "string" && /^\/reports(\/[^/\\]|\/?$)/.test(next) && !next.includes("//") ? next : `${BASE}/`;
}

export const DEV_USER = "dev@localhost";
export const DEMO_USER = "demo@example.com";

export function registerAuth(app: FastifyInstance, config: Config, db: Db): void {
  const auth = config.auth;
  const sessions = new Sessions(db, auth.idleTimeoutMs, auth.absoluteTimeoutMs);
  const pending = new Map<string, PendingLogin>();
  const devCsrf = token();
  const noLogin = auth.devBypass || auth.demo;
  const allowedHosts = new Set(auth.devBypass ? [...auth.allowedHosts, "localhost", "127.0.0.1"] : auth.allowedHosts);

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    // Probes come by pod IP, so health is exempt from the host check.
    if (path === `${BASE}/-/healthz`) return;
    // The demo answers on every preview's own hostname.
    if (!auth.demo && !allowedHosts.has(req.hostname.toLowerCase())) {
      return reply.code(MISDIRECTED_REQUEST).type("text/plain").send("Misdirected request");
    }
    if (noLogin) {
      req.user = { email: auth.demo ? DEMO_USER : DEV_USER, csrfToken: devCsrf };
    } else {
      const sid = parseCookies(req.headers.cookie)[auth.cookieName];
      const session = sid ? await sessions.get(sid) : null;
      if (session) req.user = session;
    }
    if (!req.user && !isPublic(path)) {
      if (path.startsWith(`${BASE}/api/`)) return reply.code(401).send({ error: "login required" });
      return reply.redirect(`${BASE}/auth/login?next=${encodeURIComponent(req.url)}`);
    }
    // CSRF: state-changing API calls carry the session's token in a header.
    if (path.startsWith(`${BASE}/api/`) && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const sent = req.headers["x-csrf-token"];
      if (typeof sent !== "string" || !req.user || !safeEqual(sent, req.user.csrfToken)) {
        return reply.code(403).send({ error: "bad CSRF token" });
      }
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    if (!req.url.startsWith(`${BASE}/assets/`) && !reply.hasHeader("Cache-Control")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.get(`${BASE}/auth/login`, async (req: FastifyRequest<{ Querystring: { next?: string } }>, reply: FastifyReply) => {
    if (noLogin) return reply.redirect(safeNext(req.query.next));
    const now = Date.now();
    for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
    if (pending.size > 1000) pending.clear();
    const state = token();
    const verifier = token(48);
    pending.set(state, { verifier, next: safeNext(req.query.next), expires: now + 10 * 60_000 });
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(`${auth.fireflyPublicUrl}/oauth/authorize`);
    url.search = new URLSearchParams({
      client_id: auth.clientId!,
      redirect_uri: `${auth.publicOrigin}${BASE}/auth/callback`,
      response_type: "code",
      scope: "",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    reply.header("Set-Cookie", cookie(OAUTH_COOKIE, state, { path: `${BASE}/auth`, maxAge: 600 }));
    return reply.redirect(url.toString());
  });

  app.get(
    `${BASE}/auth/callback`,
    async (req: FastifyRequest<{ Querystring: { code?: string; state?: string } }>, reply: FastifyReply) => {
      if (noLogin) return reply.redirect(`${BASE}/`);
      const fail = (reason: string) => {
        req.log.warn({ reason }, "login refused");
        return reply
          .header("Set-Cookie", cookie(OAUTH_COOKIE, "", { path: `${BASE}/auth`, maxAge: 0 }))
          .redirect(`${BASE}/auth/failed`);
      };
      const { code, state } = req.query;
      const cookieState = parseCookies(req.headers.cookie)[OAUTH_COOKIE];
      if (!code || !state || !cookieState || !safeEqual(state, cookieState)) return fail("state mismatch");
      const login = pending.get(state);
      pending.delete(state);
      if (!login || login.expires < Date.now()) return fail("state expired");

      let user: FireflyUser;
      try {
        const tokenRes = await fetch(`${auth.fireflyInternalUrl}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: auth.clientId!,
            client_secret: auth.clientSecret!,
            redirect_uri: `${auth.publicOrigin}${BASE}/auth/callback`,
            code,
            code_verifier: login.verifier,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!tokenRes.ok) return fail(`token exchange HTTP ${tokenRes.status}`);
        const accessToken = ((await tokenRes.json()) as { access_token?: string }).access_token;
        if (!accessToken) return fail("no access token");
        const userRes = await fetch(`${auth.fireflyInternalUrl}/api/v1/about/user`, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.api+json, application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        if (!userRes.ok) return fail(`user lookup HTTP ${userRes.status}`);
        user = parseFireflyUser(await userRes.json());
        // accessToken goes out of scope here and is never stored.
      } catch (err) {
        return fail(`Firefly unreachable: ${(err as Error).name}`);
      }
      if (!isAllowed(user, auth.allowedEmails)) {
        return fail(`not allowed (user ${user.id}, role ${user.role}, blocked ${user.blocked})`);
      }
      const session = await sessions.create(user.email!);
      req.log.info({ user: user.id }, "login");
      return reply
        .header("Set-Cookie", [
          cookie(auth.cookieName, session.id, { path: BASE }),
          cookie(OAUTH_COOKIE, "", { path: `${BASE}/auth`, maxAge: 0 }),
        ])
        .redirect(login.next);
    },
  );

  app.get(`${BASE}/auth/failed`, async (_req, reply) =>
    reply
      .code(403)
      .type("text/html; charset=utf-8")
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>Login refused</title><body style="font-family:system-ui;margin:2rem">` +
          `<h1>Login refused</h1><p>Only the Firefly owner can open the reports.</p>` +
          `<p><a href="${BASE}/auth/login">Try again</a></p></body>`,
      ),
  );

  app.post(`${BASE}/api/logout`, async (req, reply) => {
    const sid = parseCookies(req.headers.cookie)[auth.cookieName];
    if (sid) await sessions.destroy(sid);
    return reply.header("Set-Cookie", cookie(auth.cookieName, "", { path: BASE, maxAge: 0 })).send({ ok: true });
  });
}
