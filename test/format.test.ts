import { afterEach, describe, expect, it, vi } from "vitest";
import { dataAsOf, localDate, rangeAsOf } from "../src/web/format.js";

describe("ranges as of the data on screen", () => {
  afterEach(() => vi.useRealTimers());

  it("ends a preset on the day the data was fetched, not today", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 11, 9, 0) });
    const asOf = dataAsOf(new Date(2026, 9, 20, 18, 30).getTime());
    expect(asOf).toBe("2026-10-20");
    expect(rangeAsOf({ range: "30d", from: "x", to: "x" }, asOf)).toEqual({ range: "30d", from: "2026-09-21", to: "2026-10-20" });
    expect(rangeAsOf({ range: "3m", from: "x", to: "x" }, asOf)).toEqual({ range: "3m", from: "2026-08-01", to: "2026-10-20" });
  });

  it("uses today before any data has arrived", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 11, 9, 0) });
    expect(dataAsOf(null)).toBe("2026-11-11");
  });

  it("leaves a custom range alone", () => {
    const view = { range: null, from: "2026-01-05", to: "2026-11-11", reportId: "r" };
    expect(rangeAsOf(view, "2026-10-20")).toBe(view);
  });

  it("takes the day in the browser's zone", () => {
    expect(localDate(new Date(2026, 0, 31, 23, 59).getTime())).toBe("2026-01-31");
    expect(localDate(new Date(2026, 1, 1, 0, 1).getTime())).toBe("2026-02-01");
  });
});
