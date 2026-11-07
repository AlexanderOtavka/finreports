/**
 * Where this month's spending is headed: what is spent so far, plus what a typical month
 * still spends after this day of the month. "Typical" is the average over the complete months
 * before this one, so a big bill early in the month (rent on the 1st) is in what is spent so
 * far, and not projected again: by the 7th, the months before had already paid their rent too,
 * and what they spent after the 7th is groceries, restaurants and the bills that come later.
 * Spending a lot so far this month moves the projection up by just that much; it does not
 * assume the rest of the month keeps up the pace.
 */
import type { MonthProjection } from "../shared/api.js";

/** How many complete months before this one make up a typical month. */
export const PROJECTION_MONTHS = 12;

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** "2026-11" and `back` months before it, as "2025-11". */
function monthBefore(month: string, back: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * The projection for the month of `today`, from `txns` (what the chart counts, at any date:
 * `spend` is money out, refunds negative). A month before this one counts when the data covers
 * it from its 1st (`dataStart`, the first date with any data, accounts and all, not just what
 * is drilled into): the first month of the data is usually only partly there. Null without at
 * least one such month.
 */
export function projectMonth(
  txns: ReadonlyArray<{ date: string; spend: number }>,
  today: string,
  dataStart: string,
  months = PROJECTION_MONTHS,
): MonthProjection | null {
  const month = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const [y, m] = month.split("-").map(Number) as [number, number];
  const length = daysIn(y, m);

  const history = new Map<string, { through: number; total: number }>();
  for (let back = months; back >= 1; back -= 1) {
    const key = monthBefore(month, back);
    if (`${key}-01` >= dataStart) history.set(key, { through: 0, total: 0 });
  }
  if (!history.size) return null;

  let spent = 0;
  for (const t of txns) {
    const key = t.date.slice(0, 7);
    // Through the same day of the month. A day past the end of this month (the 31st, in
    // November) counts as its last day: on the last day, the month before is all spent too.
    const onOrBefore = Math.min(Number(t.date.slice(8, 10)), length) <= day;
    if (key === month) {
      if (t.date <= today) spent += t.spend;
      continue;
    }
    const h = history.get(key);
    if (!h) continue;
    h.total += t.spend;
    if (onOrBefore) h.through += t.spend;
  }

  const round = (v: number) => Math.round(v * 100) / 100;
  const past = [...history].map(([key, h]) => ({ month: key, through: round(h.through), total: round(h.total) }));
  const remaining = past.reduce((sum, h) => sum + (h.total - h.through), 0) / past.length;
  return {
    month,
    day,
    daysInMonth: length,
    spent: round(spent),
    // A refund-heavy history can make "the rest of the month" negative; it never un-spends.
    remaining: round(Math.max(0, remaining)),
    history: past,
  };
}
