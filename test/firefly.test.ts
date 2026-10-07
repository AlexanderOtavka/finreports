import { describe, expect, it } from "vitest";
import { FireflyAdapter } from "../src/server/adapters/firefly.js";

/** Responses shaped like Firefly III v6's API (JSON:API, as recorded from /api/v1). */
function split(overrides: Record<string, unknown>) {
  return {
    user: "1",
    transaction_journal_id: "101",
    type: "withdrawal",
    date: "2026-09-14T00:00:00-04:00",
    order: 0,
    currency_id: "1",
    currency_code: "USD",
    currency_symbol: "$",
    currency_decimal_places: 2,
    amount: "6.250000000000",
    description: "Blue Bottle Coffee",
    source_id: "3",
    source_name: "Bilt Mastercard",
    source_type: "Asset account",
    destination_id: "40",
    destination_name: "Blue Bottle Coffee",
    destination_type: "Expense account",
    budget_id: null,
    category_id: "7",
    category_name: "Food and Drink",
    tags: ["plaid-detailed-cat-coffee", "work"],
    notes: "Coffee with the new hire ",
    external_url: "https://bluebottlecoffee.com",
    latitude: 40.7186,
    longitude: -73.9563,
    external_id: "plaid-abc",
    reconciled: false,
    ...overrides,
  };
}

function group(id: string, updatedAt: string, splits: unknown[]) {
  return {
    type: "transactions",
    id,
    attributes: { created_at: updatedAt, updated_at: updatedAt, user: "1", group_title: null, transactions: splits },
    links: { self: `http://firefly/api/v1/transactions/${id}` },
  };
}

function page(data: unknown[], current: number, total: number) {
  return { data, meta: { pagination: { total: 99, count: data.length, per_page: 200, current_page: current, total_pages: total } }, links: {} };
}

interface Call {
  method: string;
  url: string;
  body?: unknown;
  auth?: string | null;
}

function mockFetch(routes: Array<[RegExp, (call: Call) => unknown]>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    };
    calls.push(call);
    for (const [re, handler] of routes) {
      if (re.test(`${call.method} ${url}`)) {
        const out = handler(call);
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/vnd.api+json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const NOW = () => new Date("2026-10-01T12:00:00Z");

describe("Firefly adapter", () => {
  it("lists every page on a full sync and maps splits to backend transactions", async () => {
    const { impl, calls } = mockFetch([
      [
        /GET .*\/api\/v1\/transactions\?type=all&start=2024-10-01&end=2026-10-08&limit=200&page=1$/,
        () =>
          page(
            [
              group("11", "2026-09-15T10:00:00-04:00", [split({})]),
              group("12", "2026-09-16T10:00:00-04:00", [
                split({
                  transaction_journal_id: "102",
                  type: "deposit",
                  amount: "3412.55",
                  description: "ACME ANALYTICS INC PAYROLL",
                  source_id: "50",
                  source_name: "Acme Analytics",
                  destination_id: "1",
                  destination_name: "Joint Checking",
                  category_name: "Income",
                  tags: ["plaid-detailed-cat-salary"],
                }),
              ]),
            ],
            1,
            2,
          ),
      ],
      [
        /GET .*page=2$/,
        () =>
          page(
            [
              group("13", "2026-09-17T10:00:00-04:00", [
                split({
                  transaction_journal_id: "103",
                  type: "transfer",
                  amount: "1000",
                  description: "ONLINE TRANSFER TO SAV",
                  source_name: "Joint Checking",
                  source_id: "1",
                  destination_id: "2",
                  destination_name: "Savings",
                  category_name: null,
                  tags: [],
                  notes: "  ",
                  external_url: "flytap.com",
                  latitude: null,
                  longitude: "-73.9",
                }),
                split({ transaction_journal_id: "104", type: "opening balance" }),
              ]),
              group("14", "2026-09-18T10:00:00-04:00", [
                split({
                  transaction_journal_id: "105",
                  description: "UBER *EATS",
                  destination_name: "(no name)",
                  // Recategorized by hand in Firefly: no longer the importer's name.
                  category_name: "Dining Out",
                  tags: ["plaid-detailed-cat-taxis-and-ride-shares"],
                }),
              ]),
            ],
            2,
            2,
          ),
      ],
    ]);
    const adapter = new FireflyAdapter({ baseUrl: "http://firefly", token: "pat", initialSyncDays: 730, fetch: impl, now: NOW });
    const changes = await adapter.listChanges(null, { full: true });

    expect(calls.every((c) => c.auth === "Bearer pat")).toBe(true);
    expect(changes.completeFrom).toBe("2024-10-01");
    expect(JSON.parse(changes.cursor)).toEqual({ v: 1, updatedAt: "2026-09-18T10:00:00-04:00" });
    expect(changes.txns).toHaveLength(4);
    const [coffee, pay, transfer, eats] = changes.txns;
    expect(coffee).toEqual({
      externalId: "101",
      groupId: "11",
      date: "2026-09-14",
      amount: -6.25,
      currency: "USD",
      type: "withdrawal",
      pending: false,
      merchant: "Blue Bottle Coffee",
      description: "Blue Bottle Coffee",
      accountId: "3",
      accountName: "Bilt Mastercard",
      counterparty: "Blue Bottle Coffee",
      website: "https://bluebottlecoffee.com",
      location: { lat: 40.7186, lon: -73.9563 },
      notes: "Coffee with the new hire",
      tags: ["work"],
      plaid: { primary: "FOOD_AND_DRINK", detailed: "COFFEE" },
      category: "Food and Drink",
      categoryFromPlaid: true,
      updatedAt: "2026-09-15T10:00:00-04:00",
    });
    expect(pay).toMatchObject({ amount: 3412.55, type: "deposit", accountName: "Joint Checking", merchant: "Acme Analytics", plaid: { primary: "INCOME", detailed: "SALARY" } });
    expect(transfer).toMatchObject({ amount: -1000, type: "transfer", merchant: null, counterparty: "Savings", plaid: null, category: null, categoryFromPlaid: false });
    // Blank notes, a URL Firefly would not link, and half a location are nothing.
    expect(transfer).toMatchObject({ notes: null, website: null, location: null, tags: [] });
    expect(eats).toMatchObject({ merchant: null, category: "Dining Out", categoryFromPlaid: false, plaid: { primary: "TRANSPORTATION", detailed: "TAXIS_AND_RIDE_SHARES" } });
  });

  it("searches by updated_at after the cursor on an incremental sync", async () => {
    const { impl, calls } = mockFetch([[/GET .*\/api\/v1\/search\/transactions/, () => page([], 1, 1)]]);
    const adapter = new FireflyAdapter({ baseUrl: "http://firefly", token: "pat", initialSyncDays: 730, fetch: impl, now: NOW });
    const cursor = JSON.stringify({ v: 1, updatedAt: "2026-09-18T10:00:00-04:00" });
    const changes = await adapter.listChanges(cursor, { full: false });
    expect(decodeURIComponent(calls[0]!.url)).toContain("query=updated_at_after:2026-09-17");
    expect(changes.completeFrom).toBeNull();
    expect(changes.cursor).toBe(cursor);
  });

  it("disambiguates a detailed tag shared by several primaries using the category", () => {
    const adapter = new FireflyAdapter({ baseUrl: "http://firefly", token: "pat", initialSyncDays: 730 });
    expect(adapter.plaidFromTags(["plaid-detailed-cat-account-transfer"], "Transfer Out")).toEqual({ primary: "TRANSFER_OUT", detailed: "ACCOUNT_TRANSFER" });
    expect(adapter.plaidFromTags(["plaid-detailed-cat-account-transfer"], "Transfer In")).toEqual({ primary: "TRANSFER_IN", detailed: "ACCOUNT_TRANSFER" });
    expect(adapter.plaidFromTags(["other-tag"], "Transfer In")).toBeNull();
  });

  it("sets a category by updating the whole group, without Firefly's rules", async () => {
    const { impl, calls } = mockFetch([
      [
        /GET .*\/api\/v1\/transaction-journals\/102$/,
        () => ({ data: group("12", "2026-09-16T10:00:00-04:00", [split({ transaction_journal_id: "101" }), split({ transaction_journal_id: "102" })]) }),
      ],
      [/PUT .*\/api\/v1\/transactions\/12$/, () => ({ data: group("12", "2026-10-01T10:00:00-04:00", []) })],
    ]);
    const adapter = new FireflyAdapter({ baseUrl: "http://firefly", token: "pat", initialSyncDays: 730, fetch: impl, now: NOW });
    await adapter.setCategory("102", "Laundry and dry cleaning");
    expect(calls[1]).toMatchObject({
      method: "PUT",
      body: {
        apply_rules: false,
        fire_webhooks: true,
        transactions: [{ transaction_journal_id: "101" }, { transaction_journal_id: "102", category_name: "Laundry and dry cleaning" }],
      },
    });
  });

  it("reports HTTP errors without echoing the response body", async () => {
    const { impl } = mockFetch([[/GET/, () => new Response("secret transaction details", { status: 500 })]]);
    const adapter = new FireflyAdapter({ baseUrl: "http://firefly", token: "pat", initialSyncDays: 730, fetch: impl, now: NOW });
    const err = await adapter.listCategories().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Firefly GET /api/v1/categories failed: HTTP 500");
  });
});
