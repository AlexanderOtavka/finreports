import type { ReportData, ReportRow } from "../shared/api.js";
import type { ChartTheme, ReportDefinition } from "./types.js";

/**
 * Spending by category: a donut of top-level categories; tap a slice for its subcategories,
 * tap a subcategory for its merchants, tap a merchant to narrow the transaction list to it.
 *
 * Colors carry the category through the drill: a category has one hue everywhere (see
 * `ChartTheme.categoryColor`), and its subcategories and merchants are shades of that hue.
 */
const OTHER_KEY = "__other__";

/** The row's color, or null when the donut folds it into the "Other" slice. */
function sliceColor(data: ReportData, row: ReportRow, index: number, theme: ChartTheme): string | null {
  if (data.level === 0) return theme.categoryColor(row.key);
  const top = data.breadcrumbs[1]?.key ?? "";
  return theme.shadeOf(theme.categoryColor(top) ?? theme.neutral, row.key, index);
}

const CENTER_NOUN = ["spent", "in this category", "in this subcategory"];

const report: ReportDefinition = {
  id: "spending-by-category",
  title: "Spending by category",
  shortTitle: "Categories",
  defaultRange: "3m",
  description: "Where the money went, by category, subcategory and merchant. Refunds net against spending.",
  rootLabel: "All spending",
  baseFilter: "t.spend <> 0",
  levels: [
    {
      name: "Category",
      query: (where) => `
        SELECT t.top_id AS key, t.top_name AS label, sum(t.spend)::float8 AS value
        FROM report_txn t
        WHERE ${where}
        GROUP BY t.top_id, t.top_name
        HAVING sum(t.spend) > 0
        ORDER BY value DESC, label`,
      filter: (key, { p }) => `t.top_id = ${p(key)}`,
    },
    {
      name: "Subcategory",
      query: (where) => `
        SELECT t.leaf_id AS key, t.leaf_name AS label, sum(t.spend)::float8 AS value
        FROM report_txn t
        WHERE ${where}
        GROUP BY t.leaf_id, t.leaf_name
        HAVING sum(t.spend) > 0
        ORDER BY value DESC, label`,
      filter: (key, { p }) => `t.leaf_id = ${p(key)}`,
    },
    {
      // Merchants as rules see them (the merchant key); named by the backend's merchant name
      // where it has one, else by the key.
      name: "Merchant",
      query: (where) => `
        SELECT t.merchant_key AS key,
               coalesce(mode() WITHIN GROUP (ORDER BY nullif(btrim(t.merchant), '')), initcap(t.merchant_key)) AS label,
               sum(t.spend)::float8 AS value
        FROM report_txn t
        WHERE ${where}
        GROUP BY t.merchant_key
        HAVING sum(t.spend) > 0
        ORDER BY value DESC, label`,
      filter: (key, { p }) => `t.merchant_key = ${p(key)}`,
    },
  ],

  rowColor: (data, row, index, theme) => sliceColor(data, row, index, theme) ?? theme.other,

  chart(data, theme, selectedKey) {
    // A donut stays readable with a handful of slices: rows without a color of their own (small
    // categories, or past the seventh shade) fold into one "Other" slice. The ranked list under
    // the chart still shows (and drills into) every row.
    const slices: Array<{ name: string; value: number; key: string; itemStyle: { color: string } }> = [];
    const folded: ReportRow[] = [];
    data.rows.forEach((row, i) => {
      const color = sliceColor(data, row, i, theme);
      if (color) slices.push({ name: row.label, value: row.value, key: row.key, itemStyle: { color } });
      else folded.push(row);
    });
    if (folded.length > 0) {
      slices.push({
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
