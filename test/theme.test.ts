import { describe, expect, it } from "vitest";
import { categoryColor, shade } from "../src/web/theme.js";

const ORDER = ["rent-and-utilities", "food-and-drink", "general-merchandise", "transportation", "travel", "personal-care", "medical", "entertainment", "general-services"];

describe("category colors", () => {
  it("gives the eight biggest categories a hue each, in palette order, and none to the rest", () => {
    expect(categoryColor(ORDER, "rent-and-utilities", false)).toBe("#2a78d6");
    expect(categoryColor(ORDER, "food-and-drink", false)).toBe("#eb6834");
    expect(categoryColor(ORDER, "food-and-drink", true)).toBe("#d95926");
    expect(categoryColor(ORDER, "entertainment", false)).toBe("#e34948");
    expect(categoryColor(ORDER, "general-services", false)).toBeNull();
    expect(categoryColor(ORDER, "nope", false)).toBeNull();
  });

  it("shades a hue into seven distinct colors, starting from the hue itself", () => {
    for (const dark of [false, true]) {
      for (const id of ORDER.slice(0, 8)) {
        const base = categoryColor(ORDER, id, dark)!;
        const shades = [...Array(7).keys()].map((slot) => shade(base, slot, dark));
        expect(shades[0]).toBe(base);
        expect(new Set(shades).size).toBe(7);
        for (const s of shades) expect(s).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});
