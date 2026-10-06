import { describe, expect, it } from "vitest";
import { addDays, generateDay, generateSample } from "../src/server/sample/generate.js";
import { merchantKey } from "../src/shared/merchant.js";

const END = "2026-09-30";

describe("sample dataset", () => {
  const data = generateSample(235, END);

  it("is deterministic", () => {
    expect(generateSample(235, END)).toEqual(data);
    expect(generateSample(236, END)).not.toEqual(data);
  });

  it("keeps a day identical when the window moves", () => {
    const later = generateSample(235, addDays(END, 30));
    const day = "2026-06-10";
    expect(later.filter((t) => t.date === day)).toEqual(data.filter((t) => t.date === day));
    // Settled days don't depend on the end date at all.
    expect(generateDay(235, day, END)).toEqual(generateDay(235, day, "2027-01-01"));
  });

  it("covers twelve months with a realistic volume", () => {
    expect(data[0]!.date).toBe(addDays(END, -364));
    expect(data[data.length - 1]!.date <= END).toBe(true);
    expect(data.length).toBeGreaterThan(1200);
    expect(data.length).toBeLessThan(3000);
    expect(new Set(data.map((t) => t.externalId)).size).toBe(data.length);
  });

  it("is a car-free household", () => {
    const carCategories = new Set(["GAS", "PARKING", "TOLLS", "CAR_PAYMENT", "AUTOMOTIVE", "RENTAL_CARS"]);
    for (const t of data) {
      expect(carCategories.has(t.truth.detailed)).toBe(false);
      expect(carCategories.has(t.plaid.detailed)).toBe(false);
    }
    const truths = new Set(data.map((t) => t.truth.detailed));
    for (const expected of ["PUBLIC_TRANSIT", "BIKES_AND_SCOOTERS", "TAXIS_AND_RIDE_SHARES", "RENT", "GROCERIES", "RESTAURANT", "COFFEE", "SALARY"]) {
      expect(truths).toContain(expected);
    }
  });

  it("has a meaningful share of Plaid mis-categorizations", () => {
    const wrong = data.filter((t) => t.plaid.detailed !== t.truth.detailed || t.plaid.primary !== t.truth.primary);
    const share = wrong.length / data.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.3);
  });

  it("has refunds, transfers, pending charges and messy descriptions", () => {
    // Refunds: money back from a merchant, filed under the purchase's category.
    expect(data.filter((t) => t.type === "deposit" && t.plaid.primary === "GENERAL_MERCHANDISE").length).toBeGreaterThan(1);
    expect(data.filter((t) => t.type === "transfer").length).toBeGreaterThan(20);
    expect(data.some((t) => t.pending)).toBe(true);
    expect(data.some((t) => t.replacesExternalId)).toBe(true);
    expect(data.some((t) => t.merchant === null && t.description.startsWith("SQ *"))).toBe(true);
  });

  it("gives every visit to a messy merchant the same key", () => {
    const laundry = data.filter((t) => t.description.startsWith("SQ *SUDS"));
    expect(laundry.length).toBeGreaterThan(30);
    expect(new Set(laundry.map((t) => merchantKey(t.merchant, t.description)))).toEqual(new Set(["suds wash and fold"]));
  });
});
