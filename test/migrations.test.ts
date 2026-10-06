import { describe, expect, it } from "vitest";
import { migrate } from "../src/server/db.js";
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
