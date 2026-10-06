import type { ReportDefinition } from "./types.js";

/**
 * Spending by category: a donut of top-level categories; tap a slice for its subcategories,
 * tap a subcategory to narrow the transaction list to it.
 */
const MAX_SLICES = 7;
const OTHER_KEY = "__other__";

const report: ReportDefinition = {
  id: "spending-by-category",
  title: "Spending by category",
  shortTitle: "Categories",
  defaultRange: "3m",
  description: "Where the money went, by category and subcategory. Refunds net against spending.",
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
  ],

  chart(data, theme, selectedKey) {
    // A donut stays readable with a handful of slices; the rest fold into one "Other"
    // slice. The ranked list under the chart still shows (and drills into) every row.
    const shown = data.rows.slice(0, MAX_SLICES);
    const rest = data.rows.slice(MAX_SLICES);
    const slices = shown.map((row, i) => ({
      name: row.label,
      value: row.value,
      key: row.key,
      itemStyle: { color: theme.colorFor(row.key, i) },
    }));
    if (rest.length > 0) {
      slices.push({
        name: `${rest.length} more`,
        value: rest.reduce((sum, row) => sum + row.value, 0),
        key: OTHER_KEY,
        itemStyle: { color: theme.dark ? "#5c5b56" : "#b9b8b2" },
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
        subtext: selectedLabel ?? (data.level === 0 ? "spent" : "in this category"),
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
