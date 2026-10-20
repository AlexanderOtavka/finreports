import { afterAll, describe, expect, it } from "vitest";
import { SampleAdapter } from "../src/server/adapters/sample.js";
import { buildApp } from "../src/server/app.js";
import { dice, nameScore, trigrams } from "../src/server/builder.js";
import { DEV_AUTH_BYPASS_VALUE, loadConfig } from "../src/server/config.js";
import { SyncService } from "../src/server/sync.js";
import type { BuilderDto, BuilderGroupDto, RulePreviewCounts, SaveRuleResponse, TxnDto } from "../src/shared/api.js";
import { descriptionKeyRule } from "../src/shared/rules.js";
import { freshDb, silentLog } from "./helpers.js";

describe("fuzzy matching", () => {
  it("compares descriptions by their letters, spaces aside", () => {
    expect(dice(trigrams("trader joe s"), trigrams("trader joes"))).toBe(1);
    expect(dice(trigrams("whole foods brk"), trigrams("wholefds brk"))).toBeGreaterThan(0.5);
    expect(dice(trigrams("key food"), trigrams("trader joes"))).toBeLessThan(0.2);
    expect(dice(trigrams(""), trigrams("x"))).toBe(0);
  });

  it("finds a merchant's name in a description, preferring the name that covers more of it", () => {
    expect(nameScore("Uber Eats", "uber eats")).toBe(1);
    expect(nameScore("Uber", "uber eats")).toBe(0.75);
    expect(nameScore("The Gate", "the gate bar brooklyn")).toBeCloseTo(2 / 3);
    expect(nameScore("Lucali", "key food")).toBe(0);
  });
});

const END = "2026-09-30";

describe("rules builder (sample backend)", async () => {
  const db = await freshDb();
  const config = loadConfig({ BACKEND: "sample", DEV_AUTH_BYPASS: DEV_AUTH_BYPASS_VALUE, SAMPLE_END_DATE: END, WEB_ROOT: "/nonexistent", LOG_LEVEL: "silent" });
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
  const post = async <T>(url: string, payload: unknown, status = 200): Promise<T> => {
    const res = await app.inject({ method: "POST", url, payload: payload as object, headers: { host: "localhost", "x-csrf-token": csrf } });
    expect(res.statusCode, res.body).toBe(status);
    return res.json() as T;
  };
  const builder = () => get<BuilderDto>("/reports/api/rules-builder");
  const group = (b: BuilderDto, key: string): BuilderGroupDto | undefined => b.groups.find((g) => g.key === key);

  const before = await builder();

  it("counts what is missing, what groups, and what is left over", () => {
    const t = before.totals;
    // The imported card's history is all missing both; Plaid's merchants it has no name for are
    // missing only the merchant.
    const imported = adapter.dataset().filter((x) => x.imported).length;
    expect(t.missingBoth).toBe(imported);
    expect(t.missingCategory).toBe(imported);
    expect(t.missingMerchant).toBeGreaterThan(imported);
    expect(t.deficient).toBe(t.missingMerchant);
    expect(t.grouped + t.singles).toBe(t.deficient);
    expect(t.groups).toBe(before.groups.filter((g) => g.size > 1).length);
    expect(t.withCandidate).toBeGreaterThan(t.missingCategory / 2);
    expect(t.withCandidate).toBeLessThan(t.deficient);
    // Groups first, biggest first; then the ones on their own.
    const sizes = before.groups.map((g) => g.size);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    // No transfers.
    expect(before.groups.some((g) => /PAYMENT TO|TRANSFER TO/.test(g.descriptions[0]!.description))).toBe(false);
  });

  it("groups the old card's statements and proposes the Plaid merchant they look like", () => {
    const tj = group(before, "trader joes")!;
    expect(tj.size).toBeGreaterThan(5);
    expect(tj).toMatchObject({ missingCategory: tj.size, missingMerchant: tj.size, accounts: ["Capital One Card ••0442"], ownCategory: null });
    expect(tj.descriptions[0]!.description).toBe("TRADER JOE'S #558");
    expect(tj.candidates[0]).toMatchObject({ merchant: "Trader Joe's", categoryId: "food-and-drink.groceries", confidence: 1, reason: "same" });
    expect(tj.candidates[0]!.evidence[0]).toMatchObject({ description: "TRADER JOE S #558 BROOKLYN NY", similarity: 1 });
    expect(tj.candidates[0]!.examples.length).toBeGreaterThan(0);
    expect(tj.candidates[0]!.examples.every((x) => x.merchant === "Trader Joe's" && x.categoryId)).toBe(true);
    expect(tj.txns.every((x) => x.merchant === null && x.categoryId === null)).toBe(true);

    // The longer name that is in the description beats the shorter one.
    expect(group(before, "uber eats")!.candidates.map((c) => c.merchant)).toEqual(["Uber Eats", "Uber"]);
    // A description written differently: a weaker, but still the best, match.
    const wf = group(before, "whole foods brk")!.candidates[0]!;
    expect(wf.merchant).toBe("Whole Foods Market");
    expect(wf.confidence).toBeGreaterThan(0.5);
    expect(wf.confidence).toBeLessThan(0.9);
    // A shop the household no longer goes to: nothing to copy from.
    expect(group(before, "key food")!.candidates).toEqual([]);
    // Plaid's own unnamed merchant: no name to copy, but its category.
    const deli = group(before, "park slope deli grocery")!;
    expect(deli.candidates).toEqual([]);
    expect(deli.ownCategory?.categoryId).toBe("general-merchandise.convenience-stores");
  });

  it("previews, saves and applies a proposed rule, which writes the merchant back and sticks", async () => {
    const tj = group(before, "trader joes")!;
    const definition = descriptionKeyRule(tj.key, { merchant: "Trader Joe's", categoryId: "food-and-drink.groceries" });
    const preview = await post<RulePreviewCounts>("/reports/api/rules/preview", { definition });
    expect(preview).toMatchObject({ count: tj.size, merchantCount: tj.size, categoryCount: tj.size });

    const saved = await post<SaveRuleResponse>("/reports/api/rules", { definition, applyToPast: true, uiContext: { surface: "rules-builder" } }, 201);
    expect(saved).toMatchObject({ action: "rule_create", backfilled: tj.size });

    // The transactions say so at once; the backend after the write-through.
    const txns = await get<TxnDto[]>("/reports/api/transactions");
    const named = txns.filter((t) => tj.txns.some((x) => x.id === t.id));
    expect(named.length).toBe(tj.txns.length);
    expect(named.every((t) => t.merchant === "Trader Joe's" && t.merchantKey === "trader joes" && t.categoryId === "food-and-drink.groceries")).toBe(true);
    await sync.pushDirty();
    const writes = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM sample_backend_write WHERE merchant_name = 'Trader Joe''s' AND category_name = 'Groceries' AND external_id LIKE 'cap1:%'",
    );
    expect(writes.rows[0]!.n).toBe(tj.size);

    // The next sync brings the backend's (now the same) merchant and category back: no change.
    expect(await sync.run()).toMatchObject({ ruleChanges: 0, pushed: 0 });
    const after = await builder();
    expect(group(after, "trader joes")).toBeUndefined();
    expect(after.totals.deficient).toBe(before.totals.deficient - tj.size);

    // The decision log has the rule and every change, merchant included.
    const events = (await app.inject({ method: "GET", url: "/reports/api/decision-events.jsonl", headers: { host: "localhost" } })).body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ action: "rule_create", newMerchant: "Trader Joe's", newCategoryId: "food-and-drink.groceries", schemaVersion: 2 });
    const backfills = events.filter((e) => e.action === "rule_backfill");
    expect(backfills).toHaveLength(tj.size);
    expect(backfills.every((e) => e.oldMerchant === null && e.newMerchant === "Trader Joe's" && e.oldCategoryId === null)).toBe(true);
    expect(backfills[0]!.uiContext).toEqual({ surface: "rules-builder" });
  });

  it("keeps applying to new matches", async () => {
    // A statement line imported later, with the same description.
    await db.query(
      `INSERT INTO txn (backend, external_id, date, amount, type, merchant_key, description, account_id, account_name)
       VALUES ('sample', 'late-import', '2025-01-02', -42.1, 'withdrawal', 'trader joes', 'TRADER JOE''S #558', 'cap1', 'Capital One Card ••0442')`,
    );
    await sync.run();
    const row = await db.query("SELECT merchant, category_id FROM txn WHERE external_id = 'late-import'");
    expect(row.rows[0]).toEqual({ merchant: "Trader Joe's", category_id: "food-and-drink.groceries" });
  });

  it("refuses a rule that sets nothing, or an unknown category", async () => {
    await post("/reports/api/rules/preview", { definition: { schema: 2, when: { descriptionKey: { equals: "x" } }, then: {} } }, 400);
    await post("/reports/api/rules", { definition: descriptionKeyRule("x", { categoryId: "no-such-category" }), applyToPast: true }, 400);
  });
});
