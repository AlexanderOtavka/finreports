import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { findReport } from "../src/reports/index.js";
import monthlyTrend from "../src/reports/monthly-trend.js";
import { inScope, runReport, selection, toReportTxn } from "../src/reports/run.js";
import type { ReportContext, ReportTxn } from "../src/reports/types.js";
import { SampleAdapter } from "../src/server/adapters/sample.js";
import { buildApp } from "../src/server/app.js";
import { DEV_AUTH_BYPASS_VALUE, loadConfig } from "../src/server/config.js";
import { SyncService } from "../src/server/sync.js";
import type { AccountDto, CategoryDto, ReportData, ReportRow, TxnDto } from "../src/shared/api.js";
import { merchantRule } from "../src/shared/rules.js";
import { freshDb, silentLog } from "./helpers.js";

const END = "2026-09-30";
const RANGE = { from: "2025-10-01", to: "2026-09-30" };

describe("API (sample backend, dev auth bypass)", async () => {
  const db = await freshDb();
  const config = loadConfig({
    BACKEND: "sample",
    DEV_AUTH_BYPASS: DEV_AUTH_BYPASS_VALUE,
    SAMPLE_END_DATE: END,
    WEB_ROOT: "/nonexistent",
    LOG_LEVEL: "silent",
    NAV_LINKS: '[{"label": "Ledger", "url": "/"}, {"label": "Docs", "url": "https://example.com/docs", "newTab": true}]',
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

  // The reports run in the browser, over every transaction; here, the same code over the same
  // responses.
  const allTxns = async (): Promise<ReportTxn[]> => {
    const [txns, categories] = await Promise.all([get<TxnDto[]>("/reports/api/transactions"), get<CategoryDto[]>("/reports/api/categories")]);
    const byId = new Map(categories.map((c) => [c.id, c]));
    return txns.map((t) => toReportTxn(t, byId));
  };
  const run = async (reportId: string, ctx: Partial<ReportContext> = {}): Promise<ReportData> => {
    const report = findReport(reportId)!;
    return runReport(report, inScope(report, await allTxns(), { ...RANGE, path: [], ...ctx }), ctx.path ?? []);
  };
  const listed = async (reportId: string, ctx: Partial<ReportContext> = {}): Promise<ReportTxn[]> => {
    const report = findReport(reportId)!;
    return selection(report, inScope(report, await allTxns(), { ...RANGE, path: [], ...ctx }), ctx.path ?? []);
  };

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

  it("hands the top bar links to the web app", async () => {
    const session = await get<{ navLinks: unknown }>("/reports/api/session");
    expect(session.navLinks).toEqual([
      { label: "Ledger", url: "/" },
      { label: "Docs", url: "https://example.com/docs", newTab: true },
    ]);
  });

  it("hands over every transaction, compressed when the browser can take it", async () => {
    const plain = await app.inject({ method: "GET", url: "/reports/api/transactions", headers: { host: "localhost" } });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const txns = plain.json() as TxnDto[];
    const count = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM txn WHERE deleted_at IS NULL");
    expect(txns).toHaveLength(count.rows[0]!.n);
    expect(txns.every((t, i) => i === 0 || t.date <= txns[i - 1]!.date)).toBe(true);
    expect(txns.find((t) => t.accountName === "Jordan Rewards Visa ••3308")!.accountId).toBe("jordan");

    const gz = await app.inject({ method: "GET", url: "/reports/api/transactions", headers: { host: "localhost", "accept-encoding": "gzip, deflate, br" } });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString("utf8"))).toEqual(txns);
  });

  it("counts spending the way the report_txn view does", async () => {
    // The browser's categories and spending (toReportTxn) against the view's, per subcategory.
    const sql = await db.query<{ key: string; label: string; value: number }>(
      `SELECT t.leaf_id AS key, t.leaf_name AS label, round(sum(t.spend)::numeric, 2)::float8 AS value
       FROM report_txn t WHERE t.date BETWEEN $1::date AND $2::date AND t.spend <> 0
       GROUP BY 1, 2 HAVING sum(t.spend) > 0`,
      [RANGE.from, RANGE.to],
    );
    const txns = (await allTxns()).filter((t) => t.date >= RANGE.from && t.date <= RANGE.to && t.spend !== 0);
    const mine = new Map<string, { label: string; value: number }>();
    for (const t of txns) {
      const row = mine.get(t.leafId) ?? { label: t.leafName, value: 0 };
      row.value += t.spend;
      mine.set(t.leafId, row);
    }
    expect(sql.rows.length).toBeGreaterThan(10);
    for (const row of sql.rows) {
      expect(mine.get(row.key)?.label).toBe(row.label);
      expect(mine.get(row.key)!.value).toBeCloseTo(row.value, 2);
    }
  });

  it("drills down the category report", async () => {
    const top = await run("spending-by-category");
    expect(top.level).toBe(0);
    expect(top.canDrill).toBe(true);
    expect(top.rows[0]!.key).toBe("rent-and-utilities");
    expect(top.rows.map((r) => r.key)).not.toContain("income");
    expect(top.rows.map((r) => r.key)).not.toContain("loan-payments");

    const food = await run("spending-by-category", { path: ["food-and-drink"] });
    expect(food.level).toBe(1);
    expect(food.breadcrumbs.map((b) => b.label)).toEqual(["All spending", "Food and Drink"]);
    expect(food.rows.map((r) => r.key)).toContain("food-and-drink.groceries");
    expect(food.total).toBeCloseTo(top.rows.find((r) => r.key === "food-and-drink")!.value, 2);

    const groceries = await run("spending-by-category", { path: ["food-and-drink", "food-and-drink.groceries"] });
    expect(groceries.level).toBe(2);
    expect(groceries.canDrill).toBe(false);
    expect(groceries.breadcrumbs.map((b) => b.label)).toEqual(["All spending", "Food and Drink", "Groceries"]);
    // The last level groups by merchant key, named by the merchant's name.
    expect(groceries.rows.length).toBeGreaterThan(1);
    expect(groceries.total).toBeCloseTo(food.rows.find((r) => r.key === "food-and-drink.groceries")!.value, 2);
    const merchant = groceries.rows[0]!;
    const path = ["food-and-drink", "food-and-drink.groceries", merchant.key];
    const picked = await run("spending-by-category", { path });
    expect(picked.level).toBe(2);
    expect(picked.breadcrumbs.at(-1)!.label).toBe(merchant.label);
    const txns = await listed("spending-by-category", { path });
    expect(txns.length).toBeGreaterThan(0);
    expect(txns.every((t) => t.merchantKey === merchant.key && t.categoryId === "food-and-drink.groceries")).toBe(true);
  });

  it("orders categories by all-time spending, for their colors", async () => {
    const order = await get<string[]>("/reports/api/category-order");
    expect(order[0]).toBe("rent-and-utilities");
    expect(order).not.toContain("income");
    expect(new Set(order).size).toBe(order.length);
  });

  it("lists the transactions behind a selection, newest first", async () => {
    const coffee = await listed("spending-by-category", { path: ["food-and-drink", "food-and-drink.coffee"] });
    expect(coffee.length).toBeGreaterThan(20);
    expect(coffee.every((t) => t.categoryId === "food-and-drink.coffee" && t.date >= RANGE.from && t.date <= RANGE.to)).toBe(true);
    expect(coffee.every((t, i) => i === 0 || t.date < coffee[i - 1]!.date || (t.date === coffee[i - 1]!.date && t.id < coffee[i - 1]!.id))).toBe(true);
  });

  it("limits reports to the chosen accounts", async () => {
    const accounts = await get<AccountDto[]>("/reports/api/accounts");
    expect(accounts.map((a) => a.id).sort()).toEqual(["chk", "jordan", "sam", "sav"]);
    expect(accounts.find((a) => a.id === "jordan")!.name).toBe("Jordan Rewards Visa ••3308");

    const all = await run("spending-by-category");
    const jordan = await run("spending-by-category", { accounts: ["jordan"] });
    const rest = await run("spending-by-category", { accounts: ["chk", "sam", "sav"] });
    expect(jordan.total).toBeGreaterThan(0);
    expect(jordan.total).toBeLessThan(all.total);
    expect(jordan.total + rest.total).toBeCloseTo(all.total, 2);

    const txns = await listed("spending-by-category", { accounts: ["jordan"] });
    expect(txns.length).toBeGreaterThan(0);
    expect(txns.every((t) => t.accountName === "Jordan Rewards Visa ••3308")).toBe(true);

    // The filter applies at every drill level, and to the monthly report too.
    const food = await run("spending-by-category", { accounts: ["jordan"], path: ["food-and-drink"] });
    expect(food.total).toBeCloseTo(jordan.rows.find((r) => r.key === "food-and-drink")!.value, 2);
    const months = await run("monthly-trend", { accounts: ["jordan"] });
    const sept = await run("spending-by-category", { from: "2026-09-01", to: "2026-09-30", accounts: ["jordan"] });
    const septBar = (months.rows as Array<ReportRow & { month: string }>).filter((r) => r.month === "2026-09").reduce((sum, r) => sum + r.value, 0);
    expect(septBar).toBeGreaterThan(0);
    expect(septBar).toBeCloseTo(sept.total, 2);
  });

  it("runs the monthly trend report", async () => {
    const months = await run("monthly-trend");
    expect(months.levels).toBe(3);
    // One row per month and category, for the stacked bars.
    const cells = months.rows as Array<ReportRow & { month: string }>;
    expect(new Set(cells.map((r) => r.month)).size).toBe(12);
    const sept = cells.filter((r) => r.month === "2026-09");
    expect(sept.length).toBeGreaterThan(3);
    expect(new Set(sept.map((r) => r.key)).size).toBe(sept.length);
    // A month's bar adds up to the category report for that month, category by category.
    const cats = await run("spending-by-category", { from: "2026-09-01", to: "2026-09-30" });
    expect(sept.reduce((sum, r) => sum + r.value, 0)).toBeCloseTo(cats.total, 2);
    for (const r of sept) expect(r.value).toBeCloseTo(cats.rows.find((c) => c.key === r.key)!.value, 2);
  });

  it("drills the monthly trend report as the category report does", async () => {
    const sept = { from: "2026-09-01", to: "2026-09-30" };
    for (const path of [["food-and-drink"], ["food-and-drink", "food-and-drink.restaurant"]]) {
      const months = await run("monthly-trend", { path });
      expect(months.level).toBe(path.length);
      expect(months.breadcrumbs.map((b) => b.label)).toEqual((await run("spending-by-category", { path })).breadcrumbs.map((b) => b.label));
      // September's bar, stacked by subcategory (or merchant), is the donut for September.
      const bar = (months.rows as Array<ReportRow & { month: string }>).filter((r) => r.month === "2026-09");
      const donut = await run("spending-by-category", { ...sept, path });
      expect(bar.length).toBe(donut.rows.length);
      for (const r of bar) expect(r.value).toBeCloseTo(donut.rows.find((d) => d.key === r.key)!.value, 2);
    }
    // A merchant picked at the last level narrows the list to it.
    const restaurants = await run("monthly-trend", { path: ["food-and-drink", "food-and-drink.restaurant"] });
    const merchant = monthlyTrend.listRows!(restaurants)[0]!;
    const path = ["food-and-drink", "food-and-drink.restaurant", merchant.key];
    expect((await run("monthly-trend", { path })).breadcrumbs.at(-1)!.label).toBe(merchant.label);
    expect((await listed("monthly-trend", { path })).every((t) => t.merchantKey === merchant.key)).toBe(true);
  });

  it("links a month to the category report for that month, clipped to the range, at the same drill path", () => {
    const ctx = { from: "2025-10-15", to: "2026-09-20", path: [] };
    expect(monthlyTrend.link!("2026-02", ctx)).toEqual({ reportId: "spending-by-category", from: "2026-02-01", to: "2026-02-28", path: [] });
    expect(monthlyTrend.link!("2025-10", ctx)).toMatchObject({ from: "2025-10-15", to: "2025-10-31" });
    expect(monthlyTrend.link!("2026-09", ctx)).toMatchObject({ from: "2026-09-01", to: "2026-09-20" });
    expect(monthlyTrend.link!("2026-09", { ...ctx, path: ["food-and-drink"] })).toMatchObject({ path: ["food-and-drink"] });
    // A category drills instead.
    expect(monthlyTrend.link!("food-and-drink", ctx)).toBeNull();
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
    const taxis = ["transportation", "transportation.taxis-and-ride-shares"];
    const eats = (await listed("spending-by-category", { path: taxis })).find((t) => t.merchant === "Uber Eats")!;
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

    const after = await listed("spending-by-category", { path: taxis });
    expect(after.some((t) => t.merchant === "Uber Eats")).toBe(false);

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

describe("NAV_LINKS", () => {
  const base = { BACKEND: "sample", DEV_AUTH_BYPASS: DEV_AUTH_BYPASS_VALUE };
  it("defaults to none", () => {
    expect(loadConfig(base).navLinks).toEqual([]);
  });
  it("accepts same-origin paths and http(s) URLs", () => {
    const links = loadConfig({ ...base, NAV_LINKS: '[{"label":" Home ","url":"/"},{"label":"Out","url":"https://example.com/x","newTab":true}]' }).navLinks;
    expect(links).toEqual([
      { label: "Home", url: "/" },
      { label: "Out", url: "https://example.com/x", newTab: true },
    ]);
  });
  it("refuses anything else", () => {
    expect(() => loadConfig({ ...base, NAV_LINKS: "Home=/" })).toThrow(/JSON array/);
    expect(() => loadConfig({ ...base, NAV_LINKS: '{"label":"a","url":"/"}' })).toThrow(/JSON array/);
    expect(() => loadConfig({ ...base, NAV_LINKS: '[{"label":"a","url":"javascript:alert(1)"}]' })).toThrow(/url must be/);
    expect(() => loadConfig({ ...base, NAV_LINKS: '[{"label":"a","url":"//evil.example"}]' })).toThrow(/url must be/);
    expect(() => loadConfig({ ...base, NAV_LINKS: '[{"label":"","url":"/"}]' })).toThrow(/label/);
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
