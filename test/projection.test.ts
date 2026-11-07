import { describe, expect, it } from "vitest";
import { projectMonth } from "../src/reports/projection.js";
import { presetRange } from "../src/web/format.js";

const t = (date: string, spend: number) => ({ date, spend });

describe("this month's projection", () => {
  // Rent on the 1st and $30 a day, every month since August.
  const typical = (month: string, days: number) => [t(`${month}-01`, 2000), ...Array.from({ length: days }, (_, i) => t(`${month}-${String(i + 1).padStart(2, "0")}`, 30))];
  const history = [...typical("2026-08", 31), ...typical("2026-09", 30), ...typical("2026-10", 31)];

  it("adds what a typical month spent after this day, not the rent again", () => {
    const p = projectMonth([...history, t("2026-11-01", 2000), t("2026-11-03", 90)], "2026-11-07", "2026-08-01")!;
    expect(p).toMatchObject({ month: "2026-11", day: 7, daysInMonth: 30, spent: 2090 });
    // After the 7th: 24, 23 and 24 days at $30.
    expect(p.remaining).toBeCloseTo(((24 + 23 + 24) * 30) / 3, 2);
    expect(p.history.map((h) => h.month)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(p.history[0]).toEqual({ month: "2026-08", through: 2210, total: 2930 });
  });

  it("does not keep up this month's pace", () => {
    const calm = projectMonth([...history, t("2026-11-02", 100)], "2026-11-07", "2026-08-01")!;
    const busy = projectMonth([...history, t("2026-11-02", 5000)], "2026-11-07", "2026-08-01")!;
    expect(busy.remaining).toBe(calm.remaining);
    expect(busy.spent - calm.spent).toBe(4900);
  });

  it("projects a big bill still to come, until its day is past", () => {
    // Before the rent's day, the months before still had it to pay.
    const late = (month: string) => [t(`${month}-05`, 2000)];
    const p = projectMonth([...late("2026-09"), ...late("2026-10")], "2026-11-03", "2026-09-01")!;
    expect(p.remaining).toBe(2000);
    expect(projectMonth([...late("2026-09"), ...late("2026-10")], "2026-11-05", "2026-09-01")!.remaining).toBe(0);
  });

  it("leaves out a month the data does not cover from its 1st", () => {
    const p = projectMonth(history, "2026-11-07", "2026-08-15")!;
    expect(p.history.map((h) => h.month)).toEqual(["2026-09", "2026-10"]);
    expect(projectMonth(history, "2026-11-07", "2026-11-02")).toBeNull();
  });

  it("is done on the last day of the month, after a longer month's 31st", () => {
    expect(projectMonth(history, "2026-11-30", "2026-08-01")!.remaining).toBe(0);
    // February's 28th: the 29th to 31st of the months before are its last day.
    expect(projectMonth(history, "2027-02-28", "2026-08-01")!.remaining).toBe(0);
  });

  it("counts up to twelve months", () => {
    const year = Array.from({ length: 24 }, (_, i) => t(`${2025 + Math.floor((i + 10) / 12) - 1}-${String(((i + 10) % 12) + 1).padStart(2, "0")}-20`, 100));
    expect(projectMonth(year, "2026-11-07", "2000-01-01")!.history).toHaveLength(12);
  });
});

describe("the three-month range", () => {
  it("is this month and the two before, whole", () => {
    expect(presetRange("3m", "2026-11-07")).toEqual({ from: "2026-09-01", to: "2026-11-07" });
    expect(presetRange("3m", "2026-01-31")).toEqual({ from: "2025-11-01", to: "2026-01-31" });
  });
});
