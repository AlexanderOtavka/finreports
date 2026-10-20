import { describe, expect, it } from "vitest";
import { recategorize } from "../src/server/actions.js";
import { CategoryIndex } from "../src/server/categories.js";
import { inTransaction, type Db } from "../src/server/db.js";
import { applyRulesToPending, backfillCandidates, deleteRule, loadActiveRules, saveRule } from "../src/server/rules.js";
import { cleanDescription, descriptionKey, merchantDisplay, merchantKey } from "../src/shared/merchant.js";
import {
  descriptionKeyRule,
  evaluate,
  merchantKeyRule,
  merchantRule,
  ruleActions,
  ruleDefinitionSchema,
  type Predicate,
  type RuleDefinition,
} from "../src/shared/rules.js";
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

  it("title-cases a shouted description for display, apostrophes and all", () => {
    expect(merchantDisplay(null, "TRADER JOE'S #558")).toBe("Trader Joe's");
    expect(merchantDisplay(null, "7-ELEVEN 34012")).toBe("7-Eleven");
    expect(merchantDisplay(null, "SQ *SUDS WASH AND FOLD 8832 BROOKLYN NY")).toBe("Suds Wash And Fold");
    expect(merchantDisplay(null, "AMZN Mktp US*2K4L19XR3")).toBe("AMZN Mktp US");
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
    expect(rows.map((r) => r.row.id).sort()).toEqual([plaidRow, backendRow].sort());
    expect(rows.every((r) => r.categoryId === LAUNDRY && r.merchant === null)).toBe(true);
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

describe("description keys", () => {
  it.each([
    ["TRADER JOE'S #558", "trader joes"],
    ["TRADER JOE S #558 BROOKLYN NY", "trader joe s"],
    ["UBER   *TRIP K3J9Z2Q1", "uber trip"],
    ["UBER *TRIP", "uber trip"],
    ["LYFT *RIDE SAT 8PM", "lyft ride sat"],
    ["MTA*NYCT PAYGO 30-DAY UNL", "mta nyct paygo 30 day unl"],
    ["7-ELEVEN 34012", "7 eleven"],
  ])("%s → %s", (raw, key) => {
    expect(descriptionKey(raw)).toBe(key);
  });

  it("matches on the description whatever the merchant is", () => {
    const rule = descriptionKeyRule("trader joes", { merchant: "Trader Joe's" });
    const csv = { merchant: null, description: "TRADER JOE'S #561", accountName: "Card", amount: -50 };
    expect(evaluate(rule.when, csv)).toBe(true);
    expect(evaluate(rule.when, { ...csv, merchant: "Trader Joe's" })).toBe(true);
    expect(evaluate(rule.when, { ...csv, description: "TRADER JOE S #558 BROOKLYN NY" })).toBe(false);
  });
});

describe("schema 2 rules", () => {
  it("set a merchant, a category, or both, and nothing else", () => {
    expect(ruleDefinitionSchema.safeParse(descriptionKeyRule("key food", { merchant: "Key Food" })).success).toBe(true);
    expect(ruleDefinitionSchema.safeParse(descriptionKeyRule("key food", { categoryId: "food-and-drink.groceries" })).success).toBe(true);
    expect(ruleDefinitionSchema.safeParse({ schema: 2, when: { descriptionKey: { equals: "x" } }, then: {} }).success).toBe(false);
    expect(ruleDefinitionSchema.safeParse({ schema: 2, when: { descriptionKey: { equals: "x" } }, then: { merchant: "  " } }).success).toBe(false);
    expect(ruleDefinitionSchema.safeParse({ schema: 2, when: { descriptionKey: { like: "x" } }, then: { merchant: "X" } }).success).toBe(false);
    // Schema 1 is unchanged: a category, always.
    expect(ruleDefinitionSchema.safeParse({ schema: 1, when: { merchant: { equals: "x" } }, then: { merchant: "X" } }).success).toBe(false);
    const parsed = ruleDefinitionSchema.parse({ schema: 2, when: { descriptionKey: { equals: "x" } }, then: { merchant: " X Co " } });
    expect(ruleActions(parsed)).toEqual({ merchant: "X Co", categoryId: null });
    expect(ruleActions(merchantRule("Lucali", "TST* LUCALI", "food-and-drink.restaurant"))).toEqual({ merchant: null, categoryId: "food-and-drink.restaurant" });
  });
});

describe("rules that set the merchant", async () => {
  const db = await freshDb();
  const categories = await CategoryIndex.load(db);
  const GROCERIES = "food-and-drink.groceries";
  const RESTAURANT = "food-and-drink.restaurant";

  let n = 0;
  /** A transaction as the backend has it: `merchant` is the backend's too. */
  async function add(f: {
    merchant?: string | null;
    merchantProvenance?: string;
    description: string;
    category?: string | null;
    provenance?: string;
    type?: string;
    needsRules?: boolean;
  }) {
    n += 1;
    const merchant = f.merchant ?? null;
    const res = await db.query<{ id: number }>(
      `INSERT INTO txn (backend, external_id, date, amount, type, merchant, backend_merchant, merchant_key, description,
         category_id, category_provenance, needs_rules, merchant_provenance)
       VALUES ('sample', $1, '2025-05-01', -20, $2, $3, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        `m${n}`,
        f.type ?? "withdrawal",
        merchant,
        merchantKey(merchant, f.description),
        f.description,
        f.category ?? null,
        f.provenance ?? "none",
        f.needsRules ?? false,
        f.merchantProvenance ?? "backend",
      ],
    );
    return res.rows[0]!.id;
  }
  const row = async (id: number) =>
    (
      await db.query(
        "SELECT merchant, merchant_key, merchant_provenance, merchant_dirty, category_id, category_provenance, backend_dirty FROM txn WHERE id = $1",
        [id],
      )
    ).rows[0];
  const save = (definition: RuleDefinition, applyToPast = true) =>
    inTransaction(db, (c) => saveRule(c, { definition, applyToPast, actor: "owner@example.com", uiContext: { surface: "rules-builder" }, categories }));

  const csvA = await add({ description: "TRADER JOE'S #558" });
  const csvB = await add({ description: "TRADER JOE'S #561" });
  const manual = await add({ description: "TRADER JOE'S #558", category: "food-and-drink.coffee", provenance: "manual" });
  const named = await add({ merchant: "Joe's Corner", description: "TRADER JOE'S #9", category: "general-merchandise.other-general-merchandise", provenance: "plaid" });
  const byHand = await add({ merchant: "Joe's Corner", merchantProvenance: "manual", description: "TRADER JOE'S #10", category: "general-merchandise.other-general-merchandise", provenance: "plaid" });
  const transfer = await add({ description: "TRADER JOE'S #558", type: "transfer" });
  const rule = descriptionKeyRule("trader joes", { merchant: "Trader Joe's", categoryId: GROCERIES });

  it("previews: the merchant and the category, never over ones set by hand", async () => {
    const found = await backfillCandidates(db, rule);
    const byId = new Map(found.map((c) => [c.row.id, { merchant: c.merchant, categoryId: c.categoryId }]));
    expect(byId).toEqual(
      new Map([
        [csvA, { merchant: "Trader Joe's", categoryId: GROCERIES }],
        [csvB, { merchant: "Trader Joe's", categoryId: GROCERIES }],
        [manual, { merchant: "Trader Joe's", categoryId: null }],
        [named, { merchant: "Trader Joe's", categoryId: GROCERIES }],
        [byHand, { merchant: null, categoryId: GROCERIES }],
      ]),
    );
  });

  it("backfills both, marks both for write-through, and logs the merchant", async () => {
    const saved = await save(rule);
    expect(saved).toMatchObject({ action: "rule_create", version: 1, backfilled: 5 });
    const p = `rule:${saved.id}`;
    expect(await row(csvA)).toEqual({
      merchant: "Trader Joe's",
      merchant_key: "trader joes",
      merchant_provenance: p,
      merchant_dirty: true,
      category_id: GROCERIES,
      category_provenance: p,
      backend_dirty: true,
    });
    expect(await row(manual)).toMatchObject({ merchant: "Trader Joe's", category_id: "food-and-drink.coffee", category_provenance: "manual" });
    // A merchant the backend has is renamed (and written back); one named by hand is not.
    expect(await row(named)).toMatchObject({ merchant: "Trader Joe's", merchant_provenance: p, merchant_dirty: true, category_id: GROCERIES });
    expect(await row(byHand)).toMatchObject({ merchant: "Joe's Corner", merchant_provenance: "manual", merchant_dirty: false, category_id: GROCERIES });
    expect(await row(transfer)).toMatchObject({ merchant: null, category_id: null });

    const events = await db.query("SELECT action, txn_id, old_merchant, new_merchant, old_category_id, new_category_id, new_provenance, schema_version FROM decision_event ORDER BY id");
    expect(events.rows[0]).toMatchObject({ action: "rule_create", txn_id: null, old_merchant: null, new_merchant: "Trader Joe's", new_category_id: GROCERIES, schema_version: 2 });
    const backfills = new Map(events.rows.slice(1).map((e) => [e.txn_id, e]));
    expect(backfills.get(csvA)).toMatchObject({ action: "rule_backfill", old_merchant: null, new_merchant: "Trader Joe's", old_category_id: null, new_category_id: GROCERIES, new_provenance: p });
    expect(backfills.get(manual)).toMatchObject({ old_merchant: null, new_merchant: "Trader Joe's", old_category_id: "food-and-drink.coffee", new_category_id: "food-and-drink.coffee", new_provenance: "manual" });
    expect(backfills.get(named)).toMatchObject({ old_merchant: "Joe's Corner", new_merchant: "Trader Joe's", new_category_id: GROCERIES });
    expect(backfills.get(byHand)).toMatchObject({ old_merchant: "Joe's Corner", new_merchant: "Joe's Corner", new_category_id: GROCERIES });
  });

  it("an \"always categorize\" rule for the merchant reaches the transactions it named", async () => {
    const saved = await save(merchantKeyRule("trader joes", RESTAURANT));
    // csvA, csvB and the renamed one, and (as merchant rules always have) the transfer, whose key
    // is its description; not the one still named Joe's Corner, and not the one set by hand.
    expect(saved.backfilled).toBe(4);
    expect(await row(csvB)).toMatchObject({ merchant: "Trader Joe's", category_id: RESTAURANT, category_provenance: `rule:${saved.id}` });
  });

  it("after a sync: the merchant first, then the newest rule for a category", async () => {
    const fresh = await add({ description: "TRADER JOE'S #570", needsRules: true });
    expect(await applyRulesToPending(db, categories)).toBe(1);
    const rules = await loadActiveRules(db);
    expect(await row(fresh)).toMatchObject({
      merchant: "Trader Joe's",
      merchant_provenance: `rule:${rules[1]!.id}`,
      merchant_dirty: true,
      category_id: RESTAURANT,
      category_provenance: `rule:${rules[0]!.id}`,
    });
  });

  it("a rule that only names the merchant hands the transactions to the category rules", async () => {
    const keyFood = await save(merchantKeyRule("key food", GROCERIES), false);
    const a = await add({ description: "KEY FOOD #1123 BROOKLYN NY" });
    const b = await add({ description: "KEY FOOD #1123 BROOKLYN NY", category: "general-merchandise.convenience-stores", provenance: "backend" });
    const named = await save(descriptionKeyRule("key food", { merchant: "Key Food" }));
    expect(named.backfilled).toBe(2);
    expect(await row(a)).toMatchObject({ merchant: "Key Food", merchant_provenance: `rule:${named.id}`, category_id: GROCERIES, category_provenance: `rule:${keyFood.id}` });
    // Like any rule after a sync, the merchant's leaves a category chosen in the backend alone.
    expect(await row(b)).toMatchObject({ merchant: "Key Food", category_id: "general-merchandise.convenience-stores", category_provenance: "backend" });
  });

  it("after a sync, leaves a merchant renamed in the ledger alone; a backfill someone asks for does not", async () => {
    const edited = await add({ merchant: "TJ's", merchantProvenance: "edited", description: "TRADER JOE'S #580", needsRules: true });
    await applyRulesToPending(db, categories);
    expect(await row(edited)).toMatchObject({ merchant: "TJ's", merchant_provenance: "edited" });
    // Saving the rule that names Trader Joe's again, applied to the past, does.
    const named = (await loadActiveRules(db)).find((r) => ruleActions(r.definition).merchant === "Trader Joe's")!;
    const again = await save(named.definition);
    expect(again.action).toBe("rule_update");
    expect(await row(edited)).toMatchObject({ merchant: "Trader Joe's", merchant_provenance: `rule:${named.id}` });
  });

});
