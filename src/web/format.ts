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
  "3m": "3M",
  "6m": "6M",
  "12m": "1Y",
  ytd: "YTD",
};

export const RANGE_TITLES: Record<RangePreset, string> = {
  "30d": "Last 30 days",
  "3m": "This month and the two before",
  "6m": "This month and the five before",
  "12m": "This month and the eleven before",
  ytd: "Since January 1",
};

/** Calendar-month ranges end today and start on the 1st, so charts show whole months. */
export function presetRange(preset: RangePreset, end = today()): { from: string; to: string } {
  const e = new Date(`${end}T00:00:00Z`);
  const monthsBack = (n: number) => iso(new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - n, 1)));
  switch (preset) {
    case "30d":
      return { from: iso(new Date(e.getTime() - 29 * 86_400_000)), to: end };
    case "3m":
      return { from: monthsBack(2), to: end };
    case "6m":
      return { from: monthsBack(5), to: end };
    case "12m":
      return { from: monthsBack(11), to: end };
    case "ytd":
      return { from: `${e.getUTCFullYear()}-01-01`, to: end };
  }
}

export function matchPreset(from: string, to: string): RangePreset | null {
  for (const p of Object.keys(RANGE_LABELS) as RangePreset[]) {
    const r = presetRange(p);
    if (r.from === from && r.to === to) return p;
  }
  return null;
}
