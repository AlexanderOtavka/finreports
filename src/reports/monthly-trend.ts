import type { ReportRow } from "../shared/api.js";
import { sliceColor } from "./category-drilldown.js";
import { sumRows } from "./run.js";
import type { ReportDefinition, ReportTxn } from "./types.js";

/**
 * Monthly spending: one bar per month, stacked by top-level category in the same colors as
 * the category report. Tap a category in the list (the chart's legend) to stack the bars by its
 * subcategories instead, and a subcategory for its merchants, as the donut drills; tap a
 * merchant to pick it out. Tap a month to open the category report for that month, at the same
 * drill path.
 */
const MONTH = /^\d{4}-\d{2}$/;
const OTHER_SERIES = "Other";

/** One row per month and series (category, subcategory or merchant); the list sums them per series. */
interface Cell extends ReportRow {
  month: string;
}

/** A level's rows: the spending per month and `key`, oldest month first. */
function cells(key: (t: ReportTxn) => string, label: (t: ReportTxn) => string) {
  return (txns: ReportTxn[]): Cell[] =>
    sumRows(txns, (t) => `${t.date.slice(0, 7)}|${key(t)}`, label)
      .map((r): Cell => ({ key: r.key.slice(8), label: r.label, value: r.value, month: r.key.slice(0, 7) }))
      .sort((a, b) => (a.month === b.month ? b.value - a.value : a.month < b.month ? -1 : 1));
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** "2026-09" → every month from the first to the last row, so a month with no spending shows. */
function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split("-").map(Number) as [number, number];
  for (let guard = 0; guard < 600; guard += 1) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= last) break;
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const report: ReportDefinition = {
  id: "monthly-trend",
  title: "Monthly spending",
  shortTitle: "Monthly",
  defaultRange: "12m",
  description: "Spending per month, stacked by category. Tap a category to stack its subcategories, a month to break it down.",
  rootLabel: "All spending",
  baseFilter: (t) => t.spend !== 0,
  // The donut's levels, each spread over the months.
  levels: [
    { name: "Category", key: (t) => t.topId, rows: cells((t) => t.topId, (t) => t.topName) },
    { name: "Subcategory", key: (t) => t.leafId, rows: cells((t) => t.leafId, (t) => t.leafName) },
    { name: "Merchant", key: (t) => t.merchantKey, rows: cells((t) => t.merchantKey, (t) => t.merchant) },
  ],

  link(key, ctx) {
    if (!MONTH.test(key)) return null;
    // The month, clipped to the range: the bar only counted those days.
    const [y, m] = key.split("-").map(Number) as [number, number];
    const start = iso(new Date(Date.UTC(y, m - 1, 1)));
    const end = iso(new Date(Date.UTC(y, m, 0)));
    return {
      reportId: "spending-by-category",
      from: start > ctx.from ? start : ctx.from,
      to: end < ctx.to ? end : ctx.to,
      path: ctx.path,
    };
  },

  listRows(data) {
    const totals = new Map<string, ReportRow>();
    for (const cell of data.rows) {
      const row = totals.get(cell.key) ?? { key: cell.key, label: cell.label, value: 0 };
      row.value += cell.value;
      totals.set(cell.key, row);
    }
    return [...totals.values()]
      .map((r) => ({ ...r, value: Math.round(r.value * 100) / 100 }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  },

  rowColor: (data, row, index, theme) => sliceColor(data, row, index, theme) ?? theme.other,

  chart(data, theme, selectedKey) {
    const rows = data.rows as Cell[];
    const months = rows.length ? monthsBetween(rows[0]!.month, rows[rows.length - 1]!.month) : [];
    const monthIndex = new Map(months.map((m, i) => [m, i]));

    // One series per row of the list with a color, biggest at the bottom (the list's order); the
    // rest, which the donut folds into one slice, stack together on top as "Other".
    const series: Array<{ id: string; name: string; color: string; values: number[] }> = [];
    const byKey = new Map<string, number[]>();
    let other: number[] | null = null;
    report.listRows!(data).forEach((row, i) => {
      const color = sliceColor(data, row, i, theme);
      if (color) {
        const values = months.map(() => 0);
        series.push({ id: row.key, name: row.label, color, values });
        byKey.set(row.key, values);
      } else {
        if (!other) {
          other = months.map(() => 0);
          series.push({ id: "__other__", name: OTHER_SERIES, color: theme.other, values: other });
        }
        byKey.set(row.key, other);
      }
    });
    for (const cell of rows) {
      const values = byKey.get(cell.key)!;
      const m = monthIndex.get(cell.month)!;
      values[m] = values[m]! + cell.value;
    }
    // A merchant picked out at the last level: the others fade.
    const picked = selectedKey && byKey.has(selectedKey) ? (series.find((s) => s.id === selectedKey) ?? null) : null;

    // Only the top segment of each bar gets rounded corners.
    const topSeries = months.map((_, m) => series.reduce((top, s, i) => (s.values[m]! > 0 ? i : top), -1));
    const monthTotals = months.map((_, m) => series.reduce((sum, s) => sum + s.values[m]!, 0));
    const axisLabel = (key: string, i: number) => {
      const [y, m] = key.split("-") as [string, string];
      const name = MONTH_NAMES[Number(m) - 1]!;
      return i === 0 || m === "01" ? `${name}\n${y}` : name;
    };

    return {
      animationDuration: 300,
      grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        confine: true,
        axisPointer: { type: "shadow", shadowStyle: { color: theme.dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" } },
        formatter: (p: unknown) => {
          const items = (p as Array<{ dataIndex: number; seriesName: string; value: number; color: string }>)
            .filter((it) => it.value > 0)
            .sort((a, b) => b.value - a.value);
          const m = items[0]?.dataIndex ?? 0;
          const [y, mm] = months[m]!.split("-") as [string, string];
          const head = `${MONTH_NAMES[Number(mm) - 1]} ${y} · <b>${theme.formatMoney(monthTotals[m]!)}</b>`;
          const lines = items.map(
            (it) =>
              `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${it.color}"></span>${it.seriesName} ${theme.formatMoney(it.value)}`,
          );
          return [head, ...lines].join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        // Each label carries its month's key: a tap anywhere in the column opens that month.
        data: months.map((key, i) => ({ value: axisLabel(key, i), key })),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: theme.grid } },
        axisLabel: { color: theme.textMuted, interval: 0, fontSize: 11, lineHeight: 13 },
      },
      yAxis: {
        type: "value",
        axisLabel: {
          color: theme.textMuted,
          formatter: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`),
        },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      // A series keeps its id from one range or set of accounts to the next, so its bars grow
      // and shrink to the new values; a drill stacks new series, drawn fresh.
      series: series.map((s, i) => ({
        id: s.id,
        type: "bar",
        name: s.name,
        stack: "spend",
        barMaxWidth: 28,
        barCategoryGap: "30%",
        itemStyle: { color: s.color, borderColor: theme.surface, borderWidth: 1, opacity: picked && picked !== s ? 0.25 : 1 },
        emphasis: { focus: "none" },
        data: s.values.map((value, m) => ({
          value,
          key: months[m],
          itemStyle: topSeries[m] === i ? { borderRadius: [4, 4, 0, 0] } : undefined,
        })),
      })),
    };
  },
};

export default report;
