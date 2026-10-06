/**
 * The report registry. To add a report, add a file next to this one that default-exports a
 * `ReportDefinition` and list it here; the first entry is the default report.
 */
import categoryDrilldown from "./category-drilldown.js";
import monthlyTrend from "./monthly-trend.js";
import type { ReportDefinition } from "./types.js";

export const REPORTS: ReportDefinition[] = [categoryDrilldown, monthlyTrend];

export function findReport(id: string): ReportDefinition | undefined {
  return REPORTS.find((r) => r.id === id);
}
