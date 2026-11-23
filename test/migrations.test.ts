import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appRoot, migrate } from "../src/server/db.js";
import { appendDecision } from "../src/server/decisions.js";
import { taxonomySeed } from "../src/shared/taxonomy.js";
import { freshDb } from "./helpers.js";

describe("migrations", async () => {
  const db = await freshDb();

  it("creates the schema and is idempotent", async () => {
    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["category", "txn", "rule", "rule_version", "decision_event", "app_state", "web_session", "report_txn"]),
    );
    expect(await migrate(db)).toEqual([]);
  });

  it("seeds the Plaid taxonomy as a two-level tree", async () => {
    const res = await db.query<{ n: number; tops: number }>(
      "SELECT count(*)::int AS n, count(*) FILTER (WHERE parent_id IS NULL)::int AS tops FROM category",
    );
    expect(res.rows[0]!.n).toBe(taxonomySeed().length);
    expect(res.rows[0]!.tops).toBe(18);
    const groceries = await db.query("SELECT parent_id, name FROM category WHERE id = 'food-and-drink.groceries'");
    expect(groceries.rows[0]).toEqual({ parent_id: "food-and-drink", name: "Groceries" });
  });

  it("rejects bad provenance values", async () => {
    await expect(
      db.query(
        `INSERT INTO txn (backend, external_id, date, amount, type, merchant_key, description, category_provenance)
         VALUES ('t', 'x', '2026-01-01', -1, 'withdrawal', 'x', 'x', 'rule:abc')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  describe("decision_event is append-only", () => {
    it("accepts inserts", async () => {
      const id = await appendDecision(db, { actor: "test", action: "recategorize", newCategoryId: "food-and-drink.coffee" });
      expect(id).toBeGreaterThan(0);
    });

    it("refuses UPDATE", async () => {
      await expect(db.query("UPDATE decision_event SET actor = 'mallory'")).rejects.toThrow(/append-only \(UPDATE refused\)/);
    });

    it("refuses DELETE", async () => {
      await expect(db.query("DELETE FROM decision_event")).rejects.toThrow(/append-only \(DELETE refused\)/);
    });

    it("refuses TRUNCATE", async () => {
      await expect(db.query("TRUNCATE decision_event")).rejects.toThrow(/append-only \(TRUNCATE refused\)/);
    });

    it("still has the row", async () => {
      const res = await db.query("SELECT actor FROM decision_event");
      expect(res.rows).toEqual([{ actor: "test" }]);
    });
  });

  it("report_txn computes spend and the top-level category", async () => {
    await db.query(
      `INSERT INTO txn (backend, external_id, date, amount, type, merchant_key, description, category_id) VALUES
       ('t', 'a', '2026-01-02', -10, 'withdrawal', 'a', 'a', 'food-and-drink.coffee'),
       ('t', 'b', '2026-01-02', 4, 'deposit', 'b', 'refund', 'food-and-drink.coffee'),
       ('t', 'c', '2026-01-02', 100, 'deposit', 'c', 'pay', 'income.salary'),
       ('t', 'd', '2026-01-02', -50, 'transfer', 'd', 'card payment', 'loan-payments.credit-card-payment'),
       ('t', 'e', '2026-01-02', -7, 'withdrawal', 'e', 'mystery', NULL)`,
    );
    const res = await db.query("SELECT external_id, top_id, leaf_id, spend FROM report_txn t JOIN txn x USING (id) ORDER BY external_id");
    expect(res.rows).toEqual([
      { external_id: "a", top_id: "food-and-drink", leaf_id: "food-and-drink.coffee", spend: 10 },
      { external_id: "b", top_id: "food-and-drink", leaf_id: "food-and-drink.coffee", spend: -4 },
      { external_id: "c", top_id: "income", leaf_id: "income.salary", spend: 0 },
      { external_id: "d", top_id: "loan-payments", leaf_id: "loan-payments.credit-card-payment", spend: 0 },
      { external_id: "e", top_id: "uncategorized", leaf_id: "uncategorized", spend: 7 },
    ]);
  });
});

describe("migrating flags to their sources", async () => {
  // Up to just before the gifts got a source, so the rows can be in the states it replaces.
  const dir = mkdtempSync(join(tmpdir(), "finreports-migrations-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const all = readdirSync(join(appRoot(), "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const copy = (files: string[]) => files.forEach((f) => copyFileSync(join(appRoot(), "migrations", f), join(dir, f)));
  copy(all.filter((f) => f < "008"));
  const db = await freshDb({ migrations: dir });

  const insert = (id: string, gift: boolean, provenance: string) =>
    db.query(
      `INSERT INTO txn (backend, external_id, date, amount, type, merchant_key, description, gift, gift_provenance)
       VALUES ('t', $1, '2026-01-01', -1, 'withdrawal', 'k', 'd', $2, $3)`,
      [id, gift, provenance],
    );

  it("gives every gift a source, keeping what is marked marked", async () => {
    await appendDecision(db, { actor: "test", action: "gift", txnSnapshot: { gift: true, giftProvenance: "manual" } });
    await insert("none", false, "none");
    await insert("manual", true, "manual");
    await insert("manual-off", false, "manual");
    await insert("rule", true, "rule:7");
    // Neither can be stored any more: a gift from nowhere, and a rule's mark that marks nothing.
    await insert("gift-from-nowhere", true, "none");
    await insert("rule-not-gift", false, "rule:7");
    copy(all.filter((f) => f >= "008"));
    expect(await migrate(db, dir)).toEqual(all.filter((f) => f >= "008"));

    const rows = await db.query("SELECT external_id, gift, gift_source FROM txn ORDER BY id");
    expect(rows.rows).toEqual([
      { external_id: "none", gift: false, gift_source: null },
      { external_id: "manual", gift: true, gift_source: "manual" },
      { external_id: "manual-off", gift: false, gift_source: "manual:off" },
      { external_id: "rule", gift: true, gift_source: "rule:7" },
      { external_id: "gift-from-nowhere", gift: true, gift_source: "manual" },
      { external_id: "rule-not-gift", gift: false, gift_source: null },
    ]);
    // The log is as it was.
    const events = await db.query("SELECT schema_version, txn_snapshot FROM decision_event");
    expect(events.rows).toEqual([{ schema_version: 2, txn_snapshot: { gift: true, giftProvenance: "manual" } }]);
  });

  it("derives gift and merchant_dirty, and refuses to store them", async () => {
    await expect(db.query("UPDATE txn SET gift = true")).rejects.toThrow(/can only be updated to DEFAULT/);
    await expect(db.query("UPDATE txn SET merchant_dirty = true")).rejects.toThrow(/can only be updated to DEFAULT/);
    await expect(db.query("UPDATE txn SET gift_source = 'none'")).rejects.toThrow(/check constraint/);
    await db.query("UPDATE txn SET merchant = 'Y', backend_merchant = 'X' WHERE external_id = 'none'");
    const dirty = await db.query("SELECT merchant_dirty FROM txn WHERE external_id = 'none'");
    expect(dirty.rows).toEqual([{ merchant_dirty: true }]);
  });

  it("only writes a category chosen here, and one that exists", async () => {
    await expect(db.query("UPDATE txn SET backend_dirty = true, category_id = 'food-and-drink.coffee', category_provenance = 'plaid' WHERE external_id = 'none'")).rejects.toThrow(
      /txn_backend_dirty_provenance_check/,
    );
    await expect(
      db.query("UPDATE txn SET backend_dirty = true, category_provenance = 'manual', category_id = NULL WHERE external_id = 'none'"),
    ).rejects.toThrow(/txn_backend_dirty_category_check/);
  });
});
