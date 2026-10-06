import type { ReportDefinition } from "./types.js";

/**
 * Monthly spending: one bar per month; tap a month for its top-level categories, tap a
 * category to narrow the transaction list to it.
 */
const report: ReportDefinition = {
  id: "monthly-trend",
  title: "Monthly spending",
  shortTitle: "Monthly",
  defaultRange: "12m",
  description: "Total spending per month, then by category within a month.",
  rootLabel: "All months",
  baseFilter: "t.spend <> 0",
  levels: [
    {
      name: "Month",
      query: (where) => `
        SELECT to_char(t.date, 'YYYY-MM') AS key,
               to_char(t.date, 'Mon YYYY') AS label,
               sum(t.spend)::float8 AS value
        FROM report_txn t
        WHERE ${where}
        GROUP BY 1, 2
        ORDER BY key`,
      filter: (key, { p }) => `to_char(t.date, 'YYYY-MM') = ${p(key)}`,
    },
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
  ],

  // Months are one series (one color); categories within a month are told apart by color.
  rowColor: (data, row, index, theme) => (data.level === 0 ? theme.colorFor("month", 0) : theme.colorFor(row.key, index)),

  chart(data, theme, selectedKey) {
    const months = data.level === 0;
    // Months read left to right; categories read best as a ranked horizontal list.
    const rows = months ? data.rows : [...data.rows].reverse();
    const labels = rows.map((r) => (months ? r.label.slice(0, 3) : r.label));
    const bars = rows.map((r, i) => ({
      value: r.value,
      key: r.key,
      itemStyle: {
        color: months ? theme.colorFor("month", 0) : theme.colorFor(r.key, rows.length - 1 - i),
        opacity: selectedKey && selectedKey !== r.key ? 0.35 : 1,
        borderRadius: months ? [4, 4, 0, 0] : [0, 4, 4, 0],
      },
    }));
    const valueAxis = {
      type: "value" as const,
      axisLabel: {
        color: theme.textMuted,
        formatter: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`),
      },
      splitLine: { lineStyle: { color: theme.grid } },
    };
    const categoryAxis = {
      type: "category" as const,
      data: labels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: theme.grid } },
      axisLabel: { color: theme.textMuted, interval: 0, fontSize: 11, width: 110, overflow: "truncate" as const },
    };
    return {
      animationDuration: 300,
      grid: months
        ? { left: 8, right: 8, top: 16, bottom: 8, containLabel: true }
        : { left: 8, right: 16, top: 8, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "item",
        confine: true,
        formatter: (p: unknown) => {
          const item = p as { dataIndex: number; value: number };
          return `${rows[item.dataIndex]?.label}<br/><b>${theme.formatMoney(item.value)}</b>`;
        },
      },
      xAxis: months ? categoryAxis : valueAxis,
      yAxis: months ? valueAxis : categoryAxis,
      series: [{ type: "bar", data: bars, barMaxWidth: 28, barCategoryGap: "30%" }],
    };
  },
};

export default report;
