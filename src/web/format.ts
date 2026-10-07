import type { RangePreset } from "../reports/types.js";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const moneyWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const formatMoney = (value: number): string => money.format(value);
/** Whole dollars, for totals and chart labels. */
export const formatMoneyShort = (value: number): string => moneyWhole.format(value);

export function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

export function formatRange(from: string, to: string): string {
  const f = new Date(`${from}T00:00:00Z`);
  const t = new Date(`${to}T00:00:00Z`);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" };
  return `${f.toLocaleDateString("en-US", opts)} – ${t.toLocaleDateString("en-US", opts)}`;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Today in the browser's zone, as an ISO date. */
export function today(): string {
  const d = new Date();
  return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
}

/** Short, so all of them and "Custom" fit across a phone. */
export const RANGE_LABELS: Record<RangePreset, string> = {
  "30d": "30D",
  "90d": "90D",
  "6m": "6M",
  "12m": "1Y",
  ytd: "YTD",
};

export const RANGE_TITLES: Record<RangePreset, string> = {
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "6m": "This month and the five before",
  "12m": "This month and the eleven before",
  ytd: "Since January 1",
};

/** Day ranges end today; calendar-month ranges end today and start on the 1st, so charts show whole months. */
export function presetRange(preset: RangePreset, end = today()): { from: string; to: string } {
  const e = new Date(`${end}T00:00:00Z`);
  const daysBack = (n: number) => iso(new Date(e.getTime() - n * 86_400_000));
  const monthsBack = (n: number) => iso(new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - n, 1)));
  switch (preset) {
    case "30d":
      return { from: daysBack(29), to: end };
    case "90d":
      return { from: daysBack(89), to: end };
    case "6m":
      return { from: monthsBack(5), to: end };
    case "12m":
      return { from: monthsBack(11), to: end };
    case "ytd":
      return { from: `${e.getUTCFullYear()}-01-01`, to: end };
  }
}

export const isPreset = (v: string | null): v is RangePreset => v !== null && Object.hasOwn(RANGE_LABELS, v);
