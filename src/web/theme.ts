import { useEffect, useState } from "react";
import type { ChartTheme } from "../reports/types.js";
import { formatMoneyShort } from "./format.js";

/**
 * The categorical palette (validated for CVD separation and contrast; see README), light and
 * dark steps of the same eight hues, assigned in this fixed order.
 */
const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

export function useDarkMode(): boolean {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/**
 * Colors follow the entity, not its rank: a key keeps the slot it first got for as long as
 * the view (report + drill level) stays the same, so a recategorization that reorders the
 * slices does not repaint them.
 */
export class ColorMemory {
  /** Slot assignments per view, kept so that drilling down and back up repaints nothing. */
  private views = new Map<string, Map<string, number>>();

  /**
   * Rows ranked past `FOLD_AT` share the neutral "everything else" color (charts fold them
   * into one mark) rather than a ninth generated hue.
   */
  colorFor(view: string, key: string, index: number, dark: boolean): string {
    let slots = this.views.get(view);
    if (!slots) {
      slots = new Map();
      this.views.set(view, slots);
    }
    // Folded rows are gray even if they had a hue before (the chart draws them as one mark);
    // their slot stays reserved for when they climb back.
    if (index >= FOLD_AT) return dark ? FOLD_DARK : FOLD_LIGHT;
    let slot = slots.get(key);
    if (slot === undefined) {
      const used = new Set(slots.values());
      slot = !used.has(index) ? index : [...Array(8).keys()].find((s) => !used.has(s));
      if (slot === undefined) return dark ? FOLD_DARK : FOLD_LIGHT;
      slots.set(key, slot);
    }
    return (dark ? DARK : LIGHT)[slot]!;
  }
}

export const FOLD_AT = 7;
const FOLD_LIGHT = "#b9b8b2";
const FOLD_DARK = "#5c5b56";

export function chartTheme(dark: boolean, colorFor: (key: string, index: number) => string): ChartTheme {
  return {
    dark,
    text: dark ? "#ffffff" : "#0b0b0b",
    textMuted: dark ? "#c3c2b7" : "#52514e",
    surface: dark ? "#1a1a19" : "#fcfcfb",
    grid: dark ? "#383835" : "#e6e5e0",
    colorFor,
    formatMoney: formatMoneyShort,
  };
}
