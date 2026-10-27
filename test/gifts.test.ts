import { describe, expect, it } from "vitest";
import { recategorize } from "../src/server/actions.js";
import { buildGroups } from "../src/server/builder.js";
import { CategoryIndex } from "../src/server/categories.js";
import { inTransaction, type Db } from "../src/server/db.js";
import { applyRulesToPending, deleteRule, listRules, ruleTransactions, saveRule } from "../src/server/rules.js";
import { toDto, type TxnRow } from "../src/server/txns.js";
import { merchantKey } from "../src/shared/merchant.js";
import { evaluate, giftRule, giftRuleParts, ruleDefinitionSchema } from "../src/shared/rules.js";
import { freshDb } from "./helpers.js";

const ME = "me@example.com";

let seq = 0;
async function addTxn(db: Db, fields: { date: string; description: string; merchant?: string | null; type?: string; needsRules?: boolean }) {
  seq += 1;
  const res = await db.query<{ id: number }>(
    `INSERT INTO txn (backend, external_id, date, amount, type, merchant, backend_merchant, merchant_key, description,
       category_id, category_provenance, website, notes, needs_rules)
     VALUES ('sample', $1, $2, -84.2, $3, $4, $4, $5, $6, 'general-merchandise.other-general-merchandise', 'plaid',
       'https://example.com', 'for the anniversary', $7) RETURNING id`,
    [`g${seq}`, fields.date, fields.type ?? "withdrawal", fields.merchant ?? null, merchantKey(fields.merchant ?? null, fields.description), fields.description, fields.needsRules ?? false],
  );
  return res.rows[0]!.id;
}

const row = async (db: Db, id: number) => (await db.query<TxnRow>("SELECT * FROM txn WHERE id = $1", [id])).rows[0]!;

describe("gift rules: the definition", () => {
  const def = giftRule({ from: "2026-11-01", to: "2026-11-10", contains: "etsy", name: "Mom's birthday" });

  it("is a valid schema 2 rule that marks a gift", () => {
    expect(ruleDefinitionSchema.safeParse(def).success).toBe(true);
    expect(def.then).toEqual({ gift: true });
    expect(giftRuleParts(def)).toEqual({ from: "2026-11-01", to: "2026-11-10", contains: "etsy" });
    expect(giftRuleParts(giftRule({ from: "2026-11-01", to: "2026-11-02" }))).toEqual({ from: "2026-11-01", to: "2026-11-02", contains: "" });
  });

  it("matches inside its dates (inclusive), on the merchant or the description", () => {
    const at = (date: string, merchant: string | null, description: string) => evaluate(def.when, { merchant, description, accountName: null, amount: -10, date });
    expect(at("2026-11-01", "Etsy", "ETSY.COM")).toBe(true);
    expect(at("2026-11-10", null, "PAYPAL *ETSY 3421")).toBe(true);
    expect(at("2026-11-11", "Etsy", "ETSY.COM")).toBe(false);
    expect(at("2026-10-31", "Etsy", "ETSY.COM")).toBe(false);
    expect(at("2026-11-05", "Amazon", "AMZN Mktp US")).toBe(false);
    // No date to look at: a date predicate matches nothing.
    expect(evaluate(def.when, { merchant: "Etsy", description: "ETSY", accountName: null, amount: -1 })).toBe(false);
  });

  it("refuses dates that are not dates", () => {
    expect(ruleDefinitionSchema.safeParse({ schema: 2, when: { date: { from: "Nov 1" } }, then: { gift: true } }).success).toBe(false);
  });
});

describe("gifts", async () => {
  const db = await freshDb();
  const categories = await CategoryIndex.load(db);

  const before = await addTxn(db, { date: "2026-10-30", merchant: "Etsy", description: "ETSY.COM 1234" });
  const inside = await addTxn(db, { date: "2026-11-03", merchant: "Etsy", description: "ETSY.COM 5678" });
  const other = await addTxn(db, { date: "2026-11-04", merchant: "Shell", description: "SHELL OIL 5521" });
  const transfer = await addTxn(db, { date: "2026-11-04", merchant: null, description: "ETSY PAYOUT TRANSFER", type: "transfer" });
  let ruleId = 0;

  it("a gift rule marks what it matches in its dates, never a transfer", async () => {
    const saved = await inTransaction(db, (c) =>
      saveRule(c, { definition: giftRule({ from: "2026-11-01", to: "2026-11-15", contains: "etsy" }), applyToPast: true, actor: ME, categories }),
    );
    ruleId = saved.id;
    expect(saved.backfilled).toBe(1);
    expect(await row(db, inside)).toMatchObject({ gift: true, gift_provenance: `rule:${ruleId}` });
    for (const id of [before, other, transfer]) expect((await row(db, id)).gift).toBe(false);
  });

  it("sends a gift as it is, marked: the app keeps its merchant out of lists and search", async () => {
    expect(toDto(await row(db, inside))).toMatchObject({ merchant: "Etsy", description: "ETSY.COM 5678", gift: true, giftSource: `rule:${ruleId}` });
    expect(toDto(await row(db, other))).toMatchObject({ gift: false, giftSource: "none" });
  });

  it("counts a gift rule's gifts and lists them", async () => {
    expect((await listRules(db)).map((r) => [r.id, r.gifted, r.applied])).toEqual([[ruleId, 1, 1]]);
    expect((await ruleTransactions(db, ruleId)).map((r) => r.id)).toEqual([inside]);
  });

  it("leaves gifts out of the rules builder's groups and look-alikes", async () => {
    await db.query("UPDATE txn SET category_id = NULL WHERE id = $1", [inside]);
    const all = (await db.query<TxnRow>("SELECT * FROM txn")).rows;
    expect(JSON.stringify(buildGroups(all))).not.toContain("5678");
    await db.query("UPDATE txn SET category_id = 'general-merchandise.other-general-merchandise' WHERE id = $1", [inside]);
  });

  it("marks new transactions in its dates as they sync, and not the ones outside", async () => {
    const later = await addTxn(db, { date: "2026-11-12", merchant: null, description: "PAYPAL *ETSY 99", needsRules: true });
    const after = await addTxn(db, { date: "2026-11-20", merchant: "Etsy", description: "ETSY.COM 1", needsRules: true });
    await applyRulesToPending(db, categories);
    expect((await row(db, later)).gift).toBe(true);
    expect((await row(db, after)).gift).toBe(false);
  });

  it("unmarked by hand, the rules leave it alone, and the log says so", async () => {
    const res = await recategorize(db, inside, { gift: false }, ME);
    expect(res.txn).toMatchObject({ merchant: "Etsy", gift: false, giftSource: "manual" });
    await db.query("UPDATE txn SET needs_rules = true WHERE id = $1", [inside]);
    await applyRulesToPending(db, categories);
    expect(await row(db, inside)).toMatchObject({ gift: false, gift_provenance: "manual" });
    const events = await db.query("SELECT action FROM decision_event WHERE txn_id = $1 ORDER BY id", [inside]);
    expect(events.rows).toEqual([{ action: "gift" }, { action: "ungift" }]);
  });

  it("marks one by hand, but never a transfer", async () => {
    const res = await recategorize(db, other, { gift: true }, ME);
    expect(res.txn).toMatchObject({ merchant: "Shell", gift: true, giftSource: "manual" });
    await expect(recategorize(db, transfer, { gift: true }, ME)).rejects.toThrow(/transfer/);
  });

  it("moving a gift rule's dates unmarks what it no longer matches; deleting it unmarks nothing", async () => {
    const later = (await db.query<{ id: number }>("SELECT id FROM txn WHERE description = 'PAYPAL *ETSY 99'")).rows[0]!.id;
    const saved = await inTransaction(db, (c) =>
      saveRule(c, { ruleId, definition: giftRule({ from: "2026-11-10", to: "2026-11-15", contains: "etsy" }), applyToPast: true, actor: ME, categories }),
    );
    expect(saved.action).toBe("rule_update");
    expect(await row(db, later)).toMatchObject({ gift: true });
    const moved = await inTransaction(db, (c) =>
      saveRule(c, { ruleId, definition: giftRule({ from: "2026-11-13", to: "2026-11-15", contains: "etsy" }), applyToPast: true, actor: ME, categories }),
    );
    expect(moved.backfilled).toBe(1);
    expect(await row(db, later)).toMatchObject({ gift: false, gift_provenance: "none" });

    await inTransaction(db, (c) =>
      saveRule(c, { ruleId, definition: giftRule({ from: "2026-11-01", to: "2026-11-15", contains: "etsy" }), applyToPast: true, actor: ME, categories }),
    );
    expect((await row(db, later)).gift).toBe(true);
    await inTransaction(db, (c) => deleteRule(c, ruleId, ME));
    expect((await row(db, later)).gift).toBe(true);
  });
});
