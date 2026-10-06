import { describe, expect, it } from "vitest";
import { recategorize } from "../src/server/actions.js";
import { CategoryIndex } from "../src/server/categories.js";
import { inTransaction, type Db } from "../src/server/db.js";
import { applyRulesToPending, backfillCandidates, deleteRule, loadActiveRules, saveRule } from "../src/server/rules.js";
import { cleanDescription, merchantKey } from "../src/shared/merchant.js";
import { evaluate, merchantRule, ruleDefinitionSchema, type Predicate } from "../src/shared/rules.js";
import { freshDb } from "./helpers.js";

describe("merchant keys", () => {
  it.each([
    ["SQ *SUDS WASH AND FOLD 8832 BROOKLYN NY", "SUDS WASH AND FOLD"],
    ["TST* KING NOODLE - BROOKLYN", "KING NOODLE - BROOKLYN"],
    ["PAYPAL *SPOTIFY 4029357733", "SPOTIFY"],
    ["AMZN Mktp US*2K4L19XR3", "AMZN Mktp US"],
    ["CHECKCARD 0914 TRADER JOE S #558 NEW YORK NY", "TRADER JOE S"],
    ["JOE PRO SHOP 0118 NEW YORK NY", "JOE PRO SHOP"],
  ])("cleans %s", (raw, cleaned) => {
    expect(cleanDescription(raw)).toBe(cleaned);
  });

  it("prefers the backend's merchant name and folds case and accents", () => {
    expect(merchantKey("Devoción", "SQ *DEVOCION")).toBe("devocion");
    expect(merchantKey(null, "SQ *DEVOCION")).toBe("devocion");
    expect(merchantKey("Trader Joe's", "whatever")).toBe("trader joes");
  });
});

describe("predicates", () => {
  const subject = { merchant: null, description: "SQ *SUDS WASH AND FOLD 8832 BROOKLYN NY", accountName: "Sam Card", amount: -34.5 };
  const cases: Array<[Predicate, boolean]> = [
    [{ merchant: { equals: "Suds Wash and Fold" } }, true],
    [{ merchant: { equals: "suds" } }, false],
    [{ merchant: { contains: "suds" } }, true],
    [{ description: { contains: "8832" } }, true],
    [{ account: { equals: "sam card" } }, true],
    [{ amount: { min: -50, max: -20 } }, true],
    [{ amount: { max: -50 } }, false],
    [{ all: [{ merchant: { contains: "suds" } }, { amount: { max: -40 } }] }, false],
    [{ any: [{ merchant: { contains: "nope" } }, { amount: { max: -30 } }] }, true],
    [{ not: { merchant: { contains: "suds" } } }, false],
  ];
  it.each(cases)("%j → %s", (predicate, expected) => {
    expect(evaluate(predicate, subject)).toBe(expected);
  });

  it("validates definitions strictly", () => {
    expect(ruleDefinitionSchema.safeParse(merchantRule(null, "SQ *SUDS", "personal-care.laundry-and-dry-cleaning")).success).toBe(true);
    expect(ruleDefinitionSchema.safeParse({ when: { merchant: { like: "x" } }, then: { categoryId: "x" } }).success).toBe(false);
    expect(ruleDefinitionSchema.safeParse({ when: { merchant: { equals: "x" } }, then: { categoryId: "x", extra: 1 } }).success).toBe(false);
  });
});

let seq = 0;
async function addTxn(db: Db, fields: { merchant?: string | null; description: string; amount?: number; category?: string | null; provenance?: string }) {
  seq += 1;
  const res = await db.query<{ id: number }>(
    `INSERT INTO txn (backend, external_id, date, amount, type, merchant, merchant_key, description, category_id, category_provenance)
     VALUES ('sample', $1, '2026-05-01', $2, 'withdrawal', $3, $4, $5, $6, $7) RETURNING id`,
    [
      `x${seq}`,
      fields.amount ?? -20,
      fields.merchant ?? null,
      merchantKey(fields.merchant ?? null, fields.description),
      fields.description,
      fields.category ?? "general-merchandise.other-general-merchandise",
      fields.provenance ?? "plaid",
    ],
  );
  return res.rows[0]!.id;
}

const LAUNDRY = "personal-care.laundry-and-dry-cleaning";

describe("rules engine", async () => {
  const db = await freshDb();
  const categories = await CategoryIndex.load(db);

  const plaidRow = await addTxn(db, { description: "SQ *SUDS WASH AND FOLD 1111 BROOKLYN NY" });
  const manualRow = await addTxn(db, { description: "SQ *SUDS WASH AND FOLD 2222 BROOKLYN NY", category: "personal-care.hair-and-beauty", provenance: "manual" });
  const backendRow = await addTxn(db, { description: "SQ *SUDS WASH AND FOLD 3333 BROOKLYN NY", category: "personal-care.other-personal-care", provenance: "backend" });
  const source = await addTxn(db, { description: "SQ *SUDS WASH AND FOLD 4444 BROOKLYN NY" });
  await addTxn(db, { description: "SQ *OTHER SHOP" });

  it("previews only what a backfill would change, never manual labels", async () => {
    const def = merchantRule(null, "SQ *SUDS WASH AND FOLD 9999 BROOKLYN NY", LAUNDRY);
    const rows = await backfillCandidates(db, def, { excludeTxnId: source });
    expect(rows.map((r) => r.id).sort()).toEqual([plaidRow, backendRow].sort());
  });

  it("recategorizing with the merchant toggle creates a rule and backfills, logging every change", async () => {
    const res = await recategorize(
      db,
      source,
      { categoryId: LAUNDRY, merchantRule: { applyToPast: true }, uiContext: { reportId: "spending-by-category", drillPath: ["shopping"] } },
      "owner@example.com",
    );
    expect(res.txn.provenance).toBe("manual");
    expect(res.rule).toMatchObject({ version: 1, backfilled: 2 });
    const ruleId = res.rule!.id;

    const rows = await db.query<{ id: number; category_id: string; category_provenance: string; backend_dirty: boolean }>(
      "SELECT id, category_id, category_provenance, backend_dirty FROM txn WHERE id = ANY($1) ORDER BY id",
      [[plaidRow, manualRow, backendRow, source]],
    );
    expect(rows.rows).toEqual([
      { id: plaidRow, category_id: LAUNDRY, category_provenance: `rule:${ruleId}`, backend_dirty: true },
      { id: manualRow, category_id: "personal-care.hair-and-beauty", category_provenance: "manual", backend_dirty: false },
      { id: backendRow, category_id: LAUNDRY, category_provenance: `rule:${ruleId}`, backend_dirty: true },
      { id: source, category_id: LAUNDRY, category_provenance: "manual", backend_dirty: true },
    ]);

    const events = await db.query("SELECT action, txn_id, old_category_id, new_category_id, new_provenance, rule_id, ui_context FROM decision_event ORDER BY id");
    expect(events.rows.map((e) => e.action)).toEqual(["recategorize", "rule_create", "rule_backfill", "rule_backfill"]);
    expect(events.rows[0]).toMatchObject({
      txn_id: source,
      old_category_id: "general-merchandise.other-general-merchandise",
      new_category_id: LAUNDRY,
      new_provenance: "manual",
      ui_context: { reportId: "spending-by-category", drillPath: ["shopping"] },
    });
    expect(events.rows[2]).toMatchObject({ rule_id: ruleId, new_provenance: `rule:${ruleId}` });
  });

  it("the same predicate again updates the rule instead of stacking a second one", async () => {
    const before = await loadActiveRules(db);
    const saved = await inTransaction(db, (c) =>
      saveRule(c, {
        definition: merchantRule(null, "SQ *SUDS WASH AND FOLD", "personal-care.other-personal-care"),
        applyToPast: false,
        actor: "owner@example.com",
        categories,
      }),
    );
    expect(saved).toMatchObject({ id: before[0]!.id, version: 2, action: "rule_update" });
    expect(await loadActiveRules(db)).toHaveLength(1);
  });

  it("applies rules to new transactions after a sync, but not to manual or backend labels", async () => {
    const fresh = await addTxn(db, { description: "SQ *SUDS WASH AND FOLD 5555 BROOKLYN NY" });
    const manual = await addTxn(db, { description: "SQ *SUDS WASH AND FOLD 6666 BROOKLYN NY", provenance: "manual", category: "food-and-drink.coffee" });
    const backend = await addTxn(db, { description: "SQ *SUDS WASH AND FOLD 7777 BROOKLYN NY", provenance: "backend", category: "food-and-drink.coffee" });
    const changed = await applyRulesToPending(db, categories);
    expect(changed).toBeGreaterThanOrEqual(1);
    const rows = await db.query<{ id: number; category_id: string; category_provenance: string; needs_rules: boolean }>(
      "SELECT id, category_id, category_provenance, needs_rules FROM txn WHERE id = ANY($1) ORDER BY id",
      [[fresh, manual, backend]],
    );
    expect(rows.rows.map((r) => [r.category_id, r.category_provenance.startsWith("rule:") ? "rule" : r.category_provenance, r.needs_rules])).toEqual([
      ["personal-care.other-personal-care", "rule", false],
      ["food-and-drink.coffee", "manual", false],
      ["food-and-drink.coffee", "backend", false],
    ]);
  });

  it("deleting a rule stops it and logs the deletion", async () => {
    const [rule] = await loadActiveRules(db);
    await inTransaction(db, (c) => deleteRule(c, rule!.id, "owner@example.com"));
    expect(await loadActiveRules(db)).toHaveLength(0);
    const last = await db.query("SELECT action, rule_id, rule_definition FROM decision_event ORDER BY id DESC LIMIT 1");
    expect(last.rows[0]).toMatchObject({ action: "rule_delete", rule_id: rule!.id });
    expect(last.rows[0].rule_definition).toEqual(rule!.definition);
  });
});
