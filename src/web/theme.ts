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
   * The slot (0-6) of `key` in `view`, or null for rows ranked past `FOLD_AT`, which share the
   * neutral "everything else" color (charts fold them into one mark) rather than a generated
   * color. A folded row's slot stays reserved for when it climbs back.
   */
  slot(view: string, key: string, index: number): number | null {
    let slots = this.views.get(view);
    if (!slots) {
      slots = new Map();
      this.views.set(view, slots);
    }
    if (index >= FOLD_AT) return null;
    let slot = slots.get(key);
    if (slot === undefined) {
      const used = new Set(slots.values());
      slot = !used.has(index) ? index : [...Array(FOLD_AT).keys()].find((s) => !used.has(s));
      if (slot === undefined) return null;
      slots.set(key, slot);
    }
    return slot;
  }

  colorFor(view: string, key: string, index: number, dark: boolean): string {
    const slot = this.slot(view, key, index);
    return slot === null ? foldColor(dark) : (dark ? DARK : LIGHT)[slot]!;
  }
}

export const FOLD_AT = 7;
const foldColor = (dark: boolean) => (dark ? "#5c5b56" : "#b9b8b2");

// --- Category hues and their shades -----------------------------------------------------------

/**
 * Category colors are fixed for the session: the top-level categories, ranked by all-time
 * spending (`/api/category-order`), take the eight hues in palette order, so Food is the same
 * orange in the monthly bars, the donut, and every drill level. Categories past the eighth
 * have no hue of their own and draw in the neutral "everything else" color.
 */
export function categoryColor(order: string[], topId: string, dark: boolean): string | null {
  const slot = order.indexOf(topId);
  return slot >= 0 && slot < LIGHT.length ? (dark ? DARK : LIGHT)[slot]! : null;
}

/**
 * Shade `slot` of `base`: slot 0 is the base itself, then alternately lighter and darker in
 * OKLCH lightness steps (+1, -1, +2, -2, …), so neighbours in a ranked donut differ by at
 * least one step and the biggest slice wears the parent's exact color. Steps that would leave
 * the readable band on this surface are skipped, which pushes a light hue (yellow) darker and
 * a dark one (violet) lighter.
 */
export function shade(base: string, slot: number, dark: boolean): string {
  if (slot === 0) return base;
  const [l, c, h] = toOklch(base);
  const [lo, hi] = dark ? [0.34, 0.92] : [0.34, 0.9];
  // A step of a seventh of the band always leaves room for all `FOLD_AT` shades in it.
  const step = (hi - lo) / FOLD_AT;
  const offsets: number[] = [];
  for (let k = 1; offsets.length < slot && k <= FOLD_AT; k += 1) {
    for (const sign of [1, -1]) {
      const target = l + sign * k * step;
      if (target >= lo && target <= hi && offsets.length < slot) offsets.push(target);
    }
  }
  const target = offsets[slot - 1] ?? l;
  // Lighter shades carry less chroma (a pastel, not a neon), darker ones keep it.
  const chroma = target > l ? c * (1 - (target - l) * 1.2) : c;
  return fromOklch(target, chroma, h);
}

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

function toOklch(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function oklchToLinear(L: number, C: number, h: number): [number, number, number] {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH to hex, lowering chroma until the color fits in sRGB (keeps hue and lightness). */
function fromOklch(L: number, C: number, h: number): string {
  let chroma = Math.max(0, C);
  let rgb = oklchToLinear(L, chroma, h);
  for (let i = 0; i < 30 && rgb.some((v) => v < -1e-4 || v > 1 + 1e-4); i += 1) {
    chroma *= 0.92;
    rgb = oklchToLinear(L, chroma, h);
  }
  return `#${rgb
    .map((v) => Math.round(Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, v))))) * 255))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

// ------------------------------------------------------------------------------------------------

export function chartTheme(dark: boolean, view: string, memory: ColorMemory, categoryOrder: string[]): ChartTheme {
  return {
    dark,
    // Firefly III's (AdminLTE's) text and box colors; see styles.css.
    text: dark ? "#e8ecee" : "#333333",
    textMuted: dark ? "#b8c7ce" : "#777777",
    surface: dark ? "#2c3b41" : "#ffffff",
    grid: dark ? "#415761" : "#f4f4f4",
    other: foldColor(dark),
    neutral: dark ? "#8f8e88" : "#86857f",
    colorFor: (key, index) => memory.colorFor(view, key, index, dark),
    categoryColor: (topId) => categoryColor(categoryOrder, topId, dark),
    shadeOf: (base, key, index) => {
      const slot = memory.slot(view, key, index);
      return slot === null ? null : shade(base, slot, dark);
    },
    formatMoney: formatMoneyShort,
  };
}
