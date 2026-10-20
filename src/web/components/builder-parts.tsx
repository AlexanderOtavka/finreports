import { formatMoney } from "../format.js";

/** How a match's confidence is shown: green, yellow or gray. */
export const confidenceLabel = (c: number): "high" | "medium" | "low" => (c >= 0.85 ? "high" : c >= 0.65 ? "medium" : "low");

/** A signed amount: money out in red, money in in green. */
export function Amount({ value }: { value: number }) {
  return (
    <span className={value > 0 ? "inflow" : value < 0 ? "outflow" : undefined}>
      {value > 0 ? "+" : ""}
      {formatMoney(Math.abs(value))}
    </span>
  );
}
