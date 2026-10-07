import { describe, expect, it } from "vitest";
import type { TxnDto } from "../src/shared/api.js";
import { CategoryTree } from "../src/web/categories.js";
import { highlightParts, parseQuery, TxnSearch } from "../src/web/search.js";

const categories = new CategoryTree([
  { id: "food-and-drink", parentId: null, name: "Food and Drink", kind: "expense", sort: 0 },
  { id: "food-and-drink.coffee", parentId: "food-and-drink", name: "Coffee", kind: "expense", sort: 0 },
  { id: "food-and-drink.restaurant", parentId: "food-and-drink", name: "Restaurants", kind: "expense", sort: 1 },
  { id: "travel", parentId: null, name: "Travel", kind: "expense", sort: 1 },
]);

function txn(id: number, overrides: Partial<TxnDto>): TxnDto {
  return {
    id,
    date: "2025-09-14",
    amount: -6.25,
    currency: "USD",
    merchant: "Blue Bottle Coffee",
    merchantKey: "blue bottle coffee",
    description: "BLUE BOTTLE COFFEE BRKLYN",
    accountName: "Jordan Rewards Visa ••3308",
    counterparty: null,
    type: "withdrawal",
    pending: false,
    plaidPrimary: "FOOD_AND_DRINK",
    plaidDetailed: "COFFEE",
    website: null,
    location: null,
    notes: null,
    tags: [],
    categoryId: "food-and-drink.coffee",
    provenance: "plaid",
    ...overrides,
  };
}

const TXNS = [
  txn(1, {}),
  txn(2, { date: "2025-09-20", merchant: "Devoción", description: "SQ *DEVOCION", amount: -5.5 }),
  txn(3, { date: "2025-10-02", merchant: "Lucali", description: "TST* LUCALI", amount: -96.4, categoryId: "food-and-drink.restaurant" }),
  txn(4, {
    date: "2025-06-08",
    merchant: "Tasca Lisbon 0412",
    description: "TASCA LISBON 0412",
    amount: -41.1,
    categoryId: "food-and-drink.restaurant",
    tags: ["trip-lisbon"],
    notes: "Dinner with Ana",
  }),
  txn(5, { date: "2025-04-26", merchant: "Airbnb", description: "AIRBNB * HM4K2", amount: -1210, categoryId: "travel", website: "https://airbnb.com" }),
];

const ids = (q: string) => new TxnSearch(TXNS, categories).filter(parseQuery(q)).map((t) => t.id);

describe("transaction search", () => {
  it("splits the query on spaces, keeps quoted phrases together, and folds case and accents", () => {
    expect(parseQuery(`  Blue "Bottle Coffee" devoción "unterminated`)).toEqual(["blue", "bottle coffee", "devocion", "unterminated"]);
    expect(parseQuery(`""   `)).toEqual([]);
  });

  it("matches the merchant, category, raw description, account, notes, tags and website", () => {
    expect(ids("lucali")).toEqual([3]);
    expect(ids("devocion")).toEqual([2]);
    expect(ids("restaurants")).toEqual([3, 4]);
    expect(ids("food")).toEqual([1, 2, 3, 4]);
    expect(ids("brklyn")).toEqual([1]);
    expect(ids("3308")).toEqual([1, 2, 3, 4, 5]);
    expect(ids("ana")).toEqual([4]);
    expect(ids("trip-lisbon")).toEqual([4]);
    expect(ids("airbnb.com")).toEqual([5]);
  });

  it("matches the date as people write it", () => {
    expect(ids("2025-09")).toEqual([1, 2]);
    expect(ids("sep 14")).toEqual([1]);
    expect(ids("september")).toEqual([1, 2]);
    expect(ids("10/2/2025")).toEqual([3]);
    expect(ids("saturday")).toEqual([2, 5]);
  });

  it("matches amounts with or without the dollar sign and comma", () => {
    expect(ids("96.40")).toEqual([3]);
    expect(ids("$1,210")).toEqual([5]);
    expect(ids("1210.00")).toEqual([5]);
  });

  it("needs every term, each in any field", () => {
    expect(ids("coffee sep")).toEqual([1, 2]);
    expect(ids("coffee sep 20")).toEqual([2]);
    expect(ids("restaurants lisbon")).toEqual([4]);
    expect(ids("lucali lisbon")).toEqual([]);
    expect(ids(`"blue bottle"`)).toEqual([1]);
    expect(ids(`"bottle blue"`)).toEqual([]);
    expect(ids("")).toEqual([1, 2, 3, 4, 5]);
  });

  it("names the hidden fields that hold a term the row does not show", () => {
    const search = new TxnSearch(TXNS, categories);
    const lisbon = TXNS[3]!;
    const visible = [lisbon.merchant, "Restaurants", "Jun 8", "$41.10"];
    expect(search.hiddenMatches(lisbon, parseQuery("lisbon ana"), visible)).toEqual([{ label: "Notes", value: "Dinner with Ana" }]);
    expect(search.hiddenMatches(lisbon, parseQuery("lisbon"), visible)).toEqual([]);
  });
});

describe("highlightParts", () => {
  it("marks every match of every term, merging overlaps, across accents", () => {
    expect(highlightParts("Devoción Coffee", ["devocion", "off", "ffee"])).toEqual([
      { text: "Devoción", match: true },
      { text: " C", match: false },
      { text: "offee", match: true },
    ]);
    expect(highlightParts("No match", ["xyz"])).toEqual([{ text: "No match", match: false }]);
    expect(highlightParts("aaa", ["aa"])).toEqual([{ text: "aaa", match: true }]);
  });
});

describe("number terms", () => {
  it("match whole numbers, so a day is not part of a year", () => {
    expect(ids("20")).toEqual([2]);
    expect(ids("09")).toEqual([1, 2]);
    expect(ids("6")).toEqual([1, 4]);
    expect(highlightParts("Sep 20, 2025", ["20"])).toEqual([
      { text: "Sep ", match: false },
      { text: "20", match: true },
      { text: ", 2025", match: false },
    ]);
  });
});
