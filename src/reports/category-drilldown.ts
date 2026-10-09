import type { ReportData, ReportRow } from "../shared/api.js";
import { sumRows } from "./run.js";
import type { ChartTheme, ReportDefinition } from "./types.js";

/**
 * Spending by category: a donut of top-level categories; tap a slice for its subcategories,
 * tap a subcategory for its merchants, tap a merchant to narrow the transaction list to it.
 *
 * Colors carry the category through the drill: a category has one hue everywhere (see
 * `ChartTheme.categoryColor`), and its subcategories and merchants are shades of that hue.
 */
const OTHER_KEY = "__other__";

/**
 * The row's color, or null when the donut folds it into the "Other" slice: the category's hue at
 * the top level, and below it, a shade of the drilled category's hue by the row's rank. The
 * monthly report colors its series the same way, level for level.
 */
export function sliceColor(data: ReportData, row: ReportRow, index: number, theme: ChartTheme): string | null {
  if (data.level === 0) return theme.categoryColor(row.key);
  const top = data.breadcrumbs[1]?.key ?? "";
  return theme.shadeOf(theme.categoryColor(top) ?? theme.neutral, index);
}

const CENTER_NOUN = ["spent", "in this category", "in this subcategory"];

const report: ReportDefinition = {
  id: "spending-by-category",
  title: "Spending by category",
  shortTitle: "Categories",
  defaultRange: "30d",
  description: "Where the money went, by category, subcategory and merchant. Refunds net against spending.",
  rootLabel: "All spending",
  baseFilter: (t) => t.spend !== 0,
  levels: [
    { name: "Category", key: (t) => t.topId, rows: (txns) => sumRows(txns, (t) => t.topId, (t) => t.topName) },
    { name: "Subcategory", key: (t) => t.leafId, rows: (txns) => sumRows(txns, (t) => t.leafId, (t) => t.leafName) },
    // Merchants as rules see them (the merchant key), named as most of their transactions are.
    { name: "Merchant", key: (t) => t.merchantKey, rows: (txns) => sumRows(txns, (t) => t.merchantKey, (t) => t.merchant) },
  ],

  rowColor: (data, row, index, theme) => sliceColor(data, row, index, theme) ?? theme.other,

  chart(data, theme, selectedKey) {
    // A donut stays readable with a handful of slices: rows without a color of their own (small
    // categories, or past the seventh shade) fold into one "Other" slice. The ranked list under
    // the chart still shows (and drills into) every row.
    const slices: Array<{ id: string; name: string; value: number; key: string; itemStyle: { color: string } }> = [];
    const folded: ReportRow[] = [];
    data.rows.forEach((row, i) => {
      const color = sliceColor(data, row, i, theme);
      if (color) slices.push({ id: row.key, name: row.label, value: row.value, key: row.key, itemStyle: { color } });
      else folded.push(row);
    });
    if (folded.length > 0) {
      slices.push({
        id: OTHER_KEY,
        name: folded.length === 1 ? folded[0]!.label : `${folded.length} more`,
        value: folded.reduce((sum, row) => sum + row.value, 0),
        key: OTHER_KEY,
        itemStyle: { color: theme.other },
      });
    }
    const selectedLabel = data.rows.find((r) => r.key === selectedKey)?.label;
    const selectedValue = data.rows.find((r) => r.key === selectedKey)?.value;
    return {
      animationDuration: 300,
      animationDurationUpdate: 300,
      tooltip: {
        trigger: "item",
        confine: true,
        formatter: (p: unknown) => {
          const item = p as { name: string; value: number; percent: number };
          return `${item.name}<br/><b>${theme.formatMoney(item.value)}</b> · ${Math.round(item.percent)}%`;
        },
      },
      title: {
        text: theme.formatMoney(selectedValue ?? data.total),
        subtext: selectedLabel ?? CENTER_NOUN[data.level] ?? "spent",
        left: "center",
        top: "center",
        textStyle: { color: theme.text, fontSize: 20, fontWeight: 600 },
        subtextStyle: { color: theme.textMuted, fontSize: 12, width: 120, overflow: "truncate" },
        itemGap: 4,
      },
      series: [
        {
          // One donut per drill path: a new range or set of accounts turns the slices to their
          // new sizes; a drill draws the next level's donut fresh.
          id: `donut:${data.breadcrumbs.slice(1, data.level + 1).map((b) => b.key).join("/")}`,
          type: "pie",
          radius: ["52%", "82%"],
          center: ["50%", "50%"],
          avoidLabelOverlap: true,
          selectedMode: "single",
          selectedOffset: 8,
          padAngle: 1,
          itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 4 },
          label: { show: false },
          labelLine: { show: false },
          emphasis: { scale: true, scaleSize: 4 },
          data: slices.map((s) => ({ ...s, selected: s.key === selectedKey })),
        },
      ],
    };
  },
};

export default report;
export { OTHER_KEY };
