import type { ReactNode } from "react";

/**
 * The tabs' icons, 24×24 line drawings in the text color. The parts marked `tab-icon-fill`
 * fill in on the active tab, the way iOS swaps a tab's outline icon for its filled one.
 */
const ICONS: Record<string, ReactNode> = {
  // A donut with one chunk slid out of it, up and to the right.
  "spending-by-category": (
    <>
      <path className="tab-icon-fill" d="M12.7 3.3A8 8 0 0 1 20.7 11.3H16.9A4.2 4.2 0 0 0 12.7 7.1Z" />
      <path d="M12.7 3.3A8 8 0 0 1 20.7 11.3H16.9A4.2 4.2 0 0 0 12.7 7.1Z" />
      <path d="M19.15 13.7A8 8 0 1 1 10.3 4.85V8.7A4.2 4.2 0 1 0 15.3 13.7Z" />
    </>
  ),
  // Three months of stacked bars, up and down: spending has no trend to cheer.
  "monthly-trend": (
    <>
      <path className="tab-icon-fill" d="M4 5h3.5v14H4zM10.25 11h3.5v8h-3.5zM16.5 7H20v12h-3.5z" />
      <path d="M4 5h3.5v14H4zM10.25 11h3.5v8h-3.5zM16.5 7H20v12h-3.5zM4 12h3.5M10.25 15h3.5M16.5 13h3.5" />
    </>
  ),
  // A wand: rules that fill in what is missing.
  "rules-builder": (
    <>
      <path className="tab-icon-fill" d="m14.5 6.5 3 3L7 20l-3-3z" />
      <path d="m14.5 6.5 3 3L7 20l-3-3zM12.5 8.5l3 3" />
      <path d="M18 2.5v3M16.5 4h3M21 8v2M20 9h2M10 3v2M9 4h2" />
    </>
  ),
};

// A plain chart, for a report with no icon of its own.
const FALLBACK = (
  <>
    <path d="M4 4v16h16" />
    <path d="m7.5 14 3.5-4 3 3 4.5-5.5" />
  </>
);

export function TabIcon({ id }: { id: string }) {
  return (
    <svg className="tab-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
      {ICONS[id] ?? FALLBACK}
    </svg>
  );
}
