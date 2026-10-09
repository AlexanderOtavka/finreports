import type { ReportRow } from "../shared/api.js";
import { sumRows } from "./run.js";
import type { ReportDefinition } from "./types.js";

/**
 * Monthly spending: one bar per month, stacked by top-level category in the same colors as
 * the category report. Tap a month to open the category report for that month; tap a category
 * in the list (the chart's legend) to open it over the whole range.
 */
const MONTH = /^\d{4}-\d{2}$/;
const OTHER_SERIES = "Other";

/** One row per month and category; the ranked list sums them per category. */
interface Cell extends ReportRow {
  top_id: string;
  top_name: string;
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

/** "2026-09" → "Sep 2026" */
const monthLabel = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

const report: ReportDefinition = {
  id: "monthly-trend",
  title: "Monthly spending",
  shortTitle: "Monthly",
  defaultRange: "12m",
  description: "Spending per month, stacked by category. Tap a month to break it down.",
  rootLabel: "All months",
  baseFilter: (t) => t.spend !== 0,
  levels: [
    {
      name: "Month",
      key: (t) => t.date.slice(0, 7),
      // A row per month and category, oldest month first.
      rows: (txns) =>
        sumRows(txns, (t) => `${t.date.slice(0, 7)}|${t.topId}`, (t) => t.topName)
          .map((r): Cell => {
            const [month, topId] = r.key.split("|") as [string, string];
            return { key: month, label: monthLabel(month), value: r.value, top_id: topId, top_name: r.label };
          })
          .sort((a, b) => (a.key === b.key ? b.value - a.value : a.key < b.key ? -1 : 1)),
    },
  ],

  link(key, ctx) {
    if (!MONTH.test(key)) return { reportId: "spending-by-category", from: ctx.from, to: ctx.to, path: [key] };
    // The month, clipped to the range: the bar only counted those days.
    const [y, m] = key.split("-").map(Number) as [number, number];
    const start = iso(new Date(Date.UTC(y, m - 1, 1)));
    const end = iso(new Date(Date.UTC(y, m, 0)));
    return {
      reportId: "spending-by-category",
      from: start > ctx.from ? start : ctx.from,
      to: end < ctx.to ? end : ctx.to,
      path: [],
    };
  },

  listRows(data) {
    const totals = new Map<string, ReportRow>();
    for (const cell of data.rows as Cell[]) {
      const row = totals.get(cell.top_id) ?? { key: cell.top_id, label: cell.top_name, value: 0 };
      row.value += cell.value;
      totals.set(cell.top_id, row);
    }
    return [...totals.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  },

  rowColor: (_data, row, _index, theme) => theme.categoryColor(row.key) ?? theme.other,

  chart(data, theme) {
    const cells = data.rows as Cell[];
    const months = cells.length ? monthsBetween(cells[0]!.key, cells[cells.length - 1]!.key) : [];
    const monthIndex = new Map(months.map((m, i) => [m, i]));
    const categories = report.listRows!(data);

    // One series per category with a hue, biggest at the bottom (the list's order); the small
    // categories without one stack together on top as "Other".
    const series: Array<{ id: string; name: string; color: string; values: number[] }> = [];
    const byCategory = new Map<string, number[]>();
    let other: number[] | null = null;
    for (const c of categories) {
      const color = theme.categoryColor(c.key);
      if (color) {
        const values = months.map(() => 0);
        series.push({ id: c.key, name: c.label, color, values });
        byCategory.set(c.key, values);
      } else {
        if (!other) {
          other = months.map(() => 0);
          series.push({ id: "__other__", name: OTHER_SERIES, color: theme.other, values: other });
        }
        byCategory.set(c.key, other);
      }
    }
    for (const cell of cells) {
      const values = byCategory.get(cell.top_id)!;
      const m = monthIndex.get(cell.key)!;
      values[m] = values[m]! + cell.value;
    }

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
      // A category's bars keep their series from one range or set of accounts to the next, so
      // they grow and shrink to the new values.
      series: series.map((s, i) => ({
        id: s.id,
        type: "bar",
        name: s.name,
        stack: "spend",
        barMaxWidth: 28,
        barCategoryGap: "30%",
        itemStyle: { color: s.color, borderColor: theme.surface, borderWidth: 1 },
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
