import { describe, expect, it } from "vitest";
import { recategorize } from "../src/server/actions.js";
import { SampleAdapter } from "../src/server/adapters/sample.js";
import type { BackendAdapter, BackendTxn, ChangeSet } from "../src/server/adapters/types.js";
import { SyncService } from "../src/server/sync.js";
import { freshDb, silentLog } from "./helpers.js";

const END = "2026-09-30";

describe("sync with the sample backend", async () => {
  const db = await freshDb();
  const adapter = new SampleAdapter(db, { seed: 235, endDate: END });
  const sync = new SyncService(db, adapter, silentLog, { intervalMs: 1000, fullIntervalMs: 86_400_000 });

  it("mirrors the dataset, mapping Plaid's categories onto leaves", async () => {
    const stats = await sync.run();
    const expected = adapter.dataset().length;
    expect(stats).toMatchObject({ full: true, received: expected, inserted: expected, pushFailed: 0 });
    const res = await db.query<{ category_id: string; category_provenance: string; backend_category: string }>(
      "SELECT category_id, category_provenance, backend_category FROM txn WHERE description LIKE 'SQ *SUDS%' LIMIT 1",
    );
    expect(res.rows[0]).toEqual({
      category_id: "general-merchandise.other-general-merchandise",
      category_provenance: "plaid",
      backend_category: "Shopping",
    });
  });

  it("is a no-op when nothing changed", async () => {
    const stats = await sync.run();
    expect(stats).toMatchObject({ full: false, inserted: 0, updated: 0, deleted: 0, pushed: 0 });
  });

  it("writes a manual category through and keeps it on the next sync", async () => {
    const row = (await db.query<{ id: number; external_id: string }>("SELECT id, external_id FROM txn WHERE description LIKE 'SQ *SUDS%' ORDER BY id LIMIT 1")).rows[0]!;
    await recategorize(db, row.id, { categoryId: "personal-care.laundry-and-dry-cleaning" }, "owner@example.com");
    expect((await sync.pushDirty()).pushed).toBe(1);
    const write = await db.query("SELECT category_name FROM sample_backend_write WHERE external_id = $1", [row.external_id]);
    expect(write.rows[0]).toEqual({ category_name: "Laundry and dry cleaning" });

    await sync.run();
    const after = await db.query("SELECT category_id, category_provenance, backend_dirty, backend_category FROM txn WHERE id = $1", [row.id]);
    expect(after.rows[0]).toEqual({
      category_id: "personal-care.laundry-and-dry-cleaning",
      category_provenance: "manual",
      backend_dirty: false,
      backend_category: "Laundry and dry cleaning",
    });
  });

  it("treats a category changed in the backend as the backend's decision", async () => {
    const row = (await db.query<{ id: number; external_id: string }>("SELECT id, external_id FROM txn WHERE merchant = 'Netflix' ORDER BY id LIMIT 1")).rows[0]!;
    await adapter.setCategory(row.external_id, "Music and audio");
    await sync.run();
    const after = await db.query("SELECT category_id, category_provenance FROM txn WHERE id = $1", [row.id]);
    expect(after.rows[0]).toEqual({ category_id: "entertainment.music-and-audio", category_provenance: "backend" });
  });

  it("a forced full sync finds nothing deleted", async () => {
    const stats = await sync.run({ full: true });
    expect(stats.deleted).toBe(0);
  });
});

/** A scripted backend for the edge cases the sample data does not hit on demand. */
class ScriptedAdapter implements BackendAdapter {
  readonly name = "scripted";
  next: ChangeSet = { txns: [], removed: [], cursor: "c", completeFrom: null };
  writes: Array<[string, string]> = [];
  failWrites = false;
  async listAccounts() {
    return [];
  }
  async listCategories() {
    return [];
  }
  async listChanges(): Promise<ChangeSet> {
    return this.next;
  }
  async setCategory(id: string, name: string) {
    if (this.failWrites) throw new Error("backend down");
    this.writes.push([id, name]);
  }
}

function txn(overrides: Partial<BackendTxn>): BackendTxn {
  return {
    externalId: "t1",
    groupId: null,
    date: "2026-09-28",
    amount: -48.5,
    currency: "USD",
    type: "withdrawal",
    pending: true,
    merchant: "Lucali",
    description: "TST* LUCALI",
    accountId: "a",
    accountName: "Card",
    counterparty: "Lucali",
    plaid: { primary: "FOOD_AND_DRINK", detailed: "RESTAURANT" },
    category: "Food and Drink",
    categoryFromPlaid: true,
    updatedAt: "2026-09-28T12:00:00Z",
    ...overrides,
  };
}

describe("sync edge cases", async () => {
  const db = await freshDb();
  const adapter = new ScriptedAdapter();
  const sync = new SyncService(db, adapter, silentLog, { intervalMs: 1000, fullIntervalMs: 86_400_000 });

  it("keeps the merchant's website and location and the ledger's notes and tags", async () => {
    const details = { website: "https://lucali.com", location: { lat: 40.6818, lon: -73.9998 }, notes: "Birthday", tags: ["date-night"] };
    adapter.next = { txns: [txn({ externalId: "d1", pending: false, ...details })], removed: [], cursor: "c0", completeFrom: null };
    await sync.run();
    const row = await db.query("SELECT website, latitude, longitude, notes, tags FROM txn WHERE external_id = 'd1'");
    expect(row.rows[0]).toEqual({ website: "https://lucali.com", latitude: 40.6818, longitude: -73.9998, notes: "Birthday", tags: ["date-night"] });
    // The same again is no change; new tags are.
    expect(await sync.run()).toMatchObject({ inserted: 0, updated: 0 });
    adapter.next = { ...adapter.next, txns: [txn({ externalId: "d1", pending: false, ...details, tags: ["date-night", "split"] })] };
    expect(await sync.run()).toMatchObject({ updated: 1 });
    expect((await db.query("SELECT tags FROM txn WHERE external_id = 'd1'")).rows[0]).toEqual({ tags: ["date-night", "split"] });
    await db.query("DELETE FROM txn WHERE external_id = 'd1'");
  });

  it("creates categories the backend invented", async () => {
    adapter.next = { txns: [txn({ externalId: "k1", category: "Kids", categoryFromPlaid: false, pending: false })], removed: [], cursor: "c1", completeFrom: null };
    await sync.run();
    const row = await db.query("SELECT category_id, category_provenance FROM txn WHERE external_id = 'k1'");
    expect(row.rows[0]).toEqual({ category_id: "kids", category_provenance: "backend" });
  });

  it("carries a manual decision from a pending charge to its posted replacement", async () => {
    adapter.next = { txns: [txn({})], removed: [], cursor: "c2", completeFrom: null };
    await sync.run();
    const pending = (await db.query<{ id: number }>("SELECT id FROM txn WHERE external_id = 't1'")).rows[0]!;
    await recategorize(db, pending.id, { categoryId: "food-and-drink.restaurant" }, "owner@example.com");
    await sync.pushDirty();

    adapter.next = {
      txns: [txn({ externalId: "t1-posted", pending: false, amount: -58.5, replacesExternalId: "t1" })],
      removed: ["t1"],
      cursor: "c3",
      completeFrom: null,
    };
    const stats = await sync.run();
    expect(stats).toMatchObject({ inserted: 1, deleted: 1 });
    const rows = await db.query("SELECT external_id, category_id, category_provenance, deleted_at IS NOT NULL AS deleted FROM txn WHERE external_id LIKE 't1%' ORDER BY id");
    expect(rows.rows).toEqual([
      { external_id: "t1", category_id: "food-and-drink.restaurant", category_provenance: "manual", deleted: true },
      { external_id: "t1-posted", category_id: "food-and-drink.restaurant", category_provenance: "manual", deleted: false },
    ]);
    expect(adapter.writes).toContainEqual(["t1-posted", "Restaurants"]);
  });

  it("keeps a failed write-through dirty and retries it", async () => {
    const row = (await db.query<{ id: number }>("SELECT id FROM txn WHERE external_id = 'k1'")).rows[0]!;
    adapter.failWrites = true;
    await recategorize(db, row.id, { categoryId: "general-services.childcare" }, "owner@example.com");
    expect(await sync.pushDirty()).toEqual({ pushed: 0, failed: 1 });
    adapter.failWrites = false;
    expect(await sync.pushDirty()).toEqual({ pushed: 1, failed: 0 });
    expect(adapter.writes).toContainEqual(["k1", "Childcare"]);
  });

  it("marks rows missing from a complete listing as deleted", async () => {
    adapter.next = { txns: [txn({ externalId: "t1-posted", pending: false, amount: -58.5 })], removed: [], cursor: "c4", completeFrom: "2026-01-01" };
    const stats = await sync.run({ full: true });
    expect(stats.deleted).toBe(1); // k1
    const k1 = await db.query("SELECT deleted_at IS NOT NULL AS deleted FROM txn WHERE external_id = 'k1'");
    expect(k1.rows[0]).toEqual({ deleted: true });
  });
});
