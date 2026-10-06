import { afterAll, describe, expect, it } from "vitest";
import { SampleAdapter } from "../src/server/adapters/sample.js";
import { buildApp } from "../src/server/app.js";
import { DEV_AUTH_BYPASS_VALUE, loadConfig } from "../src/server/config.js";
import { SyncService } from "../src/server/sync.js";
import type { ReportData, TxnPage } from "../src/shared/api.js";
import { merchantRule } from "../src/shared/rules.js";
import { freshDb, silentLog } from "./helpers.js";

const END = "2026-09-30";
const RANGE = "from=2025-10-01&to=2026-09-30";

describe("API (sample backend, dev auth bypass)", async () => {
  const db = await freshDb();
  const config = loadConfig({
    BACKEND: "sample",
    DEV_AUTH_BYPASS: DEV_AUTH_BYPASS_VALUE,
    SAMPLE_END_DATE: END,
    WEB_ROOT: "/nonexistent",
    LOG_LEVEL: "silent",
  });
  const adapter = new SampleAdapter(db, { seed: 235, endDate: END });
  const sync = new SyncService(db, adapter, silentLog, { intervalMs: 1000, fullIntervalMs: 86_400_000 });
  await sync.run();
  const app = await buildApp({ config, db, adapter, sync });
  afterAll(() => app.close());

  const get = async <T>(url: string): Promise<T> => {
    const res = await app.inject({ method: "GET", url, headers: { host: "localhost" } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as T;
  };
  const csrf = (await get<{ csrfToken: string }>("/reports/api/session")).csrfToken;
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, payload: payload as object, headers: { host: "localhost", "x-csrf-token": csrf, ...headers } });

  it("serves health without a host check", async () => {
    const res = await app.inject({ method: "GET", url: "/reports/-/healthz", headers: { host: "10.42.0.7:8080" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("refuses unknown hosts and sets security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/reports/api/session", headers: { host: "evil.example" } });
    expect(res.statusCode).toBe(421);
    const ok = await app.inject({ method: "GET", url: "/reports/api/session", headers: { host: "localhost" } });
    expect(ok.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(ok.headers["x-frame-options"]).toBe("DENY");
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("drills down the category report", async () => {
    const top = await get<ReportData>(`/reports/api/reports/spending-by-category/data?${RANGE}`);
    expect(top.level).toBe(0);
    expect(top.canDrill).toBe(true);
    expect(top.rows[0]!.key).toBe("rent-and-utilities");
    expect(top.rows.map((r) => r.key)).not.toContain("income");
    expect(top.rows.map((r) => r.key)).not.toContain("loan-payments");

    const food = await get<ReportData>(`/reports/api/reports/spending-by-category/data?${RANGE}&path=food-and-drink`);
    expect(food.level).toBe(1);
    expect(food.breadcrumbs.map((b) => b.label)).toEqual(["All spending", "Food and Drink"]);
    expect(food.rows.map((r) => r.key)).toContain("food-and-drink.groceries");
    expect(food.total).toBeCloseTo(top.rows.find((r) => r.key === "food-and-drink")!.value, 2);

    const groceries = await get<ReportData>(`/reports/api/reports/spending-by-category/data?${RANGE}&path=food-and-drink/food-and-drink.groceries`);
    expect(groceries.level).toBe(1);
    expect(groceries.breadcrumbs.map((b) => b.label)).toEqual(["All spending", "Food and Drink", "Groceries"]);
  });

  it("lists the transactions behind a selection, paginated", async () => {
    const first = await get<TxnPage>(`/reports/api/reports/spending-by-category/transactions?${RANGE}&path=food-and-drink/food-and-drink.coffee&limit=20`);
    expect(first.items).toHaveLength(20);
    expect(first.total).toBeGreaterThan(20);
    expect(first.items.every((t) => t.categoryId === "food-and-drink.coffee")).toBe(true);
    const second = await get<TxnPage>(
      `/reports/api/reports/spending-by-category/transactions?${RANGE}&path=food-and-drink/food-and-drink.coffee&limit=20&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.items[0]!.date <= first.items[19]!.date).toBe(true);
  });

  it("runs the monthly trend report", async () => {
    const months = await get<ReportData>(`/reports/api/reports/monthly-trend/data?${RANGE}`);
    expect(months.rows).toHaveLength(12);
    const sept = await get<ReportData>(`/reports/api/reports/monthly-trend/data?${RANGE}&path=2026-09`);
    expect(sept.breadcrumbs.at(-1)!.label).toBe("Sep 2026");
  });

  it("requires a CSRF token for writes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/reports/api/transactions/1/category",
      payload: { categoryId: "food-and-drink.coffee" },
      headers: { host: "localhost" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("recategorizes with a merchant rule: preview, apply, log, export", async () => {
    const shopping = await get<TxnPage>(`/reports/api/reports/spending-by-category/transactions?${RANGE}&path=transportation/transportation.taxis-and-ride-shares&limit=200`);
    const eats = shopping.items.find((t) => t.merchant === "Uber Eats")!;
    expect(eats).toBeDefined();

    const suggestions = await get<{ likely: string[]; recent: string[] }>(`/reports/api/transactions/${eats.id}/suggestions`);
    expect(suggestions.likely).toContain("transportation.taxis-and-ride-shares");

    const preview = await post("/reports/api/rules/preview", {
      definition: merchantRule("Uber Eats", eats.description, "food-and-drink.restaurant"),
      excludeTxnId: eats.id,
    });
    expect(preview.statusCode).toBe(200);
    const count = preview.json().count as number;
    expect(count).toBeGreaterThan(20);

    const res = await post(`/reports/api/transactions/${eats.id}/category`, {
      categoryId: "food-and-drink.restaurant",
      merchantRule: { applyToPast: true },
      uiContext: { reportId: "spending-by-category", drillPath: ["transportation", "transportation.taxis-and-ride-shares"], from: "2025-10-01", to: "2026-09-30" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().rule.backfilled).toBe(count);
    expect(res.json().txn).toMatchObject({ id: eats.id, categoryId: "food-and-drink.restaurant", provenance: "manual" });

    const after = await get<TxnPage>(`/reports/api/reports/spending-by-category/transactions?${RANGE}&path=transportation/transportation.taxis-and-ride-shares&limit=200`);
    expect(after.items.some((t) => t.merchant === "Uber Eats")).toBe(false);

    const exported = await app.inject({ method: "GET", url: "/reports/api/decision-events.jsonl", headers: { host: "localhost" } });
    expect(exported.headers["content-type"]).toContain("application/x-ndjson");
    const events = exported.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.action)).toEqual(["recategorize", "rule_create", ...Array(count).fill("rule_backfill")]);
    expect(events[0]).toMatchObject({
      actor: "dev@localhost",
      txnId: eats.id,
      oldCategoryId: "transportation.taxis-and-ride-shares",
      oldProvenance: "plaid",
      newCategoryId: "food-and-drink.restaurant",
      newProvenance: "manual",
      txn: { merchant: "Uber Eats", plaidPrimary: "TRANSPORTATION", plaidDetailed: "TAXIS_AND_RIDE_SHARES", backendCategory: "Transportation", amount: eats.amount },
      uiContext: { reportId: "spending-by-category", drillPath: ["transportation", "transportation.taxis-and-ride-shares"] },
    });
    expect(events[1].rule).toEqual({ schema: 1, when: { merchant: { equals: "uber eats" } }, then: { categoryId: "food-and-drink.restaurant" } });

    const tail = await app.inject({ method: "GET", url: `/reports/api/decision-events.jsonl?after=${events[1].id}`, headers: { host: "localhost" } });
    expect(tail.body.trim().split("\n")).toHaveLength(count);
  });

  it("rejects bad input", async () => {
    expect((await post("/reports/api/transactions/1/category", { categoryId: "nope" })).statusCode).toBe(400);
    expect((await post("/reports/api/transactions/999999/category", { categoryId: "food-and-drink.coffee" })).statusCode).toBe(404);
    expect((await post("/reports/api/rules", { definition: { when: { merchant: { like: "x" } }, then: { categoryId: "food-and-drink.coffee" } } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/reports/api/reports/spending-by-category/data?from=yesterday&to=2026-01-01", headers: { host: "localhost" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/reports/api/reports/nope/data?" + RANGE, headers: { host: "localhost" } })).statusCode).toBe(404);
  });

  it("creates subcategories one level deep", async () => {
    const ok = await post("/reports/api/categories", { name: "Cat food", parentId: "general-merchandise" });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ id: "general-merchandise.cat-food", parentId: "general-merchandise" });
    const deep = await post("/reports/api/categories", { name: "Wet food", parentId: "general-merchandise.cat-food" });
    expect(deep.statusCode).toBe(400);
    const dup = await post("/reports/api/categories", { name: "groceries", parentId: null });
    expect(dup.statusCode).toBe(409);
  });
});

describe("config guards the dev auth bypass", () => {
  it("refuses it with the Firefly backend", () => {
    expect(() => loadConfig({ BACKEND: "firefly", FIREFLY_TOKEN: "x", DEV_AUTH_BYPASS: DEV_AUTH_BYPASS_VALUE })).toThrow(/refused with BACKEND=firefly/);
  });
  it("refuses it in production", () => {
    expect(() => loadConfig({ BACKEND: "sample", NODE_ENV: "production", DEV_AUTH_BYPASS: DEV_AUTH_BYPASS_VALUE })).toThrow(/NODE_ENV=production/);
  });
  it("refuses a casual value", () => {
    expect(() => loadConfig({ BACKEND: "sample", DEV_AUTH_BYPASS: "1" })).toThrow(/must be unset or exactly/);
  });
  it("requires OAuth settings without it", () => {
    expect(() => loadConfig({ BACKEND: "sample" })).toThrow(/OAUTH_CLIENT_ID/);
    expect(() => loadConfig({ BACKEND: "sample", OAUTH_CLIENT_ID: "3", OAUTH_CLIENT_SECRET: "s" })).toThrow(/ALLOWED_EMAILS/);
    expect(() =>
      loadConfig({ BACKEND: "sample", OAUTH_CLIENT_ID: "3", OAUTH_CLIENT_SECRET: "s", ALLOWED_EMAILS: "owner@example.com" }),
    ).toThrow(/PUBLIC_ORIGIN/);
  });
});
