import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SampleAdapter } from "../src/server/adapters/sample.js";
import { buildApp } from "../src/server/app.js";
import { isAllowed, parseCookies, parseFireflyUser } from "../src/server/auth.js";
import { loadConfig } from "../src/server/config.js";
import { SyncService } from "../src/server/sync.js";
import { freshDb, silentLog } from "./helpers.js";

const HOST = "firefly.example.com";

describe("Firefly user check", () => {
  const user = (attributes: Record<string, unknown>) => parseFireflyUser({ data: { id: "1", attributes } });
  const allowed = ["owner@example.com"];
  it.each([
    [{ email: "Owner@Example.com", role: "owner", blocked: false }, true],
    [{ email: "owner@example.com", role: "demo", blocked: false }, false],
    [{ email: "owner@example.com", role: "owner", blocked: true }, false],
    [{ email: "owner@example.com", role: "owner" }, false], // missing blocked: fail closed
    [{ email: "someone@example.com", role: "owner", blocked: false }, false],
  ])("%j → %s", (attributes, expected) => {
    expect(isAllowed(user(attributes), allowed)).toBe(expected);
  });
});

describe("OAuth login", async () => {
  const db = await freshDb();
  const config = loadConfig({
    BACKEND: "sample",
    OAUTH_CLIENT_ID: "7",
    OAUTH_CLIENT_SECRET: "client-secret",
    ALLOWED_EMAILS: "owner@example.com",
    // As a typical Kubernetes deployment sets them.
    NODE_ENV: "production",
    PUBLIC_ORIGIN: "https://firefly.example.com",
    FIREFLY_PUBLIC_URL: "https://firefly.example.com",
    FIREFLY_INTERNAL_URL: "http://firefly.firefly.svc.cluster.local",
    WEB_ROOT: "/nonexistent",
    LOG_LEVEL: "silent",
  });
  const adapter = new SampleAdapter(db, { seed: 1, endDate: "2026-09-30" });
  const sync = new SyncService(db, adapter, silentLog, { intervalMs: 1000, fullIntervalMs: 1000 });
  const app = await buildApp({ config, db, adapter, sync });
  afterAll(() => app.close());
  afterEach(() => vi.unstubAllGlobals());

  const req = (url: string, cookie?: string) =>
    app.inject({ method: "GET", url, headers: { host: HOST, ...(cookie ? { cookie } : {}) } });

  function stubFirefly(user: Record<string, unknown>) {
    const calls: Array<{ url: string; body?: string; auth?: string | null }> = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? String(init.body) : undefined, auth: new Headers(init?.headers).get("authorization") });
      if (String(input).endsWith("/oauth/token")) return Response.json({ access_token: "firefly-token", token_type: "Bearer" });
      if (String(input).endsWith("/api/v1/about/user")) return Response.json({ data: { type: "users", id: "1", attributes: user } });
      return new Response("nope", { status: 404 });
    });
    return calls;
  }

  async function login(): Promise<{ state: string; oauthCookie: string; location: URL }> {
    const res = await req("/reports/auth/login?next=%2Freports%2F%3Fr%3Dmonthly-trend");
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/^REPORTSOAUTH=[^;]+; Path=\/reports\/auth; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    return { state: location.searchParams.get("state")!, oauthCookie: setCookie.split(";")[0]!, location };
  }

  it("sends anonymous page loads to login and API calls a 401", async () => {
    const page = await req("/reports/");
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe("/reports/auth/login?next=%2Freports%2F");
    expect((await req("/reports/api/session")).statusCode).toBe(401);
    expect((await req("/reports/-/healthz")).statusCode).toBe(200);
  });

  it("authorizes at the public URL with PKCE", async () => {
    const { location } = await login();
    expect(location.origin + location.pathname).toBe("https://firefly.example.com/oauth/authorize");
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: "7",
      redirect_uri: "https://firefly.example.com/reports/auth/callback",
      response_type: "code",
      code_challenge_method: "S256",
    });
  });

  it("logs in the Firefly owner, exchanging the code in-cluster", async () => {
    const calls = stubFirefly({ email: "owner@example.com", role: "owner", blocked: false });
    const { state, oauthCookie } = await login();
    const res = await req(`/reports/auth/callback?code=abc&state=${state}`, oauthCookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/reports/?r=monthly-trend");
    const cookies = res.headers["set-cookie"] as string[];
    const session = cookies.find((c) => c.startsWith("REPORTSSESSION="))!;
    expect(session).toMatch(/; Path=\/reports; Secure; HttpOnly; SameSite=Lax$/);

    expect(calls[0]!.url).toBe("http://firefly.firefly.svc.cluster.local/oauth/token");
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("client_secret")).toBe("client-secret");
    expect(form.get("code_verifier")).toBeTruthy();
    expect(calls[1]).toMatchObject({ url: "http://firefly.firefly.svc.cluster.local/api/v1/about/user", auth: "Bearer firefly-token" });

    const me = await req("/reports/api/session", session.split(";")[0]);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: "owner@example.com", devBypass: false });
    // The Firefly token is not kept anywhere.
    const stored = await db.query("SELECT * FROM web_session");
    expect(JSON.stringify(stored.rows)).not.toContain("firefly-token");
  });

  it("refuses a non-owner", async () => {
    stubFirefly({ email: "owner@example.com", role: "demo", blocked: false });
    const { state, oauthCookie } = await login();
    const res = await req(`/reports/auth/callback?code=abc&state=${state}`, oauthCookie);
    expect(res.headers.location).toBe("/reports/auth/failed");
    expect(String(res.headers["set-cookie"])).not.toContain("REPORTSSESSION=");
  });

  it("refuses a callback whose state does not match the browser's", async () => {
    stubFirefly({ email: "owner@example.com", role: "owner", blocked: false });
    const { state } = await login();
    const res = await req(`/reports/auth/callback?code=abc&state=${state}`, "REPORTSOAUTH=other");
    expect(res.headers.location).toBe("/reports/auth/failed");
  });

  it("never redirects off-site after login", async () => {
    const res = await req("/reports/auth/login?next=https%3A%2F%2Fevil.example%2F");
    const { state } = { state: new URL(res.headers.location as string).searchParams.get("state")! };
    stubFirefly({ email: "owner@example.com", role: "owner", blocked: false });
    const cb = await req(`/reports/auth/callback?code=abc&state=${state}`, String(res.headers["set-cookie"]).split(";")[0]);
    expect(cb.headers.location).toBe("/reports/");
  });

  it("expires idle sessions", async () => {
    stubFirefly({ email: "owner@example.com", role: "owner", blocked: false });
    const { state, oauthCookie } = await login();
    const res = await req(`/reports/auth/callback?code=abc&state=${state}`, oauthCookie);
    const session = (res.headers["set-cookie"] as string[]).find((c) => c.startsWith("REPORTSSESSION="))!.split(";")[0]!;
    await db.query("UPDATE web_session SET last_seen_at = now() - interval '31 minutes'");
    expect((await req("/reports/api/session", session)).statusCode).toBe(401);
  });

  it("parses cookies defensively", () => {
    expect(parseCookies("a=1; b=%ZZ; a=2; c=x=y")).toEqual({ a: "1", c: "x=y" });
  });
});
