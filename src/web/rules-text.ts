import { giftRuleParts, ruleActions, type Predicate, type RuleDefinition, type TextMatch } from "../shared/rules.js";
import { formatDate, formatMoney, formatRange, today } from "./format.js";

/** A rule's predicate in words, as in "When <this>, …". */
export function describePredicate(p: Predicate): string {
  const text = (m: TextMatch) => ("equals" in m ? `is “${m.equals}”` : `contains “${m.contains}”`);
  if ("merchant" in p) return `the merchant ${text(p.merchant)}`;
  if ("descriptionKey" in p) {
    return "equals" in p.descriptionKey
      ? `the description reduces to “${p.descriptionKey.equals}”`
      : `the reduced description contains “${p.descriptionKey.contains}”`;
  }
  if ("description" in p) return `the description ${text(p.description)}`;
  if ("account" in p) return `the account ${text(p.account)}`;
  if ("amount" in p) {
    const { min, max } = p.amount;
    const money = (n: number) => `${n < 0 ? "−" : ""}${formatMoney(Math.abs(n))}`;
    if (min !== undefined && max !== undefined) return `the amount is between ${money(min)} and ${money(max)}`;
    if (min !== undefined) return `the amount is at least ${money(min)}`;
    if (max !== undefined) return `the amount is at most ${money(max)}`;
    return "any amount";
  }
  if ("date" in p) {
    const { from, to } = p.date;
    if (from && to) return from === to ? `it is on ${formatDate(from)}` : `it is from ${formatRange(from, to)}`;
    if (from) return `it is on or after ${formatDate(from)}`;
    if (to) return `it is on or before ${formatDate(to)}`;
    return "any date";
  }
  const nested = (q: Predicate) => ("all" in q || "any" in q ? `(${describePredicate(q)})` : describePredicate(q));
  if ("all" in p) return p.all.map(nested).join(" and ");
  if ("any" in p) return p.any.map(nested).join(" or ");
  return `not ${nested(p.not)}`;
}

/** A normalized key ("uber eats") as a name ("Uber Eats"). */
const titleCase = (key: string) => key.replace(/(^|\s)([a-z])/g, (_, before: string, c: string) => before + c.toUpperCase());

/**
 * What to call a rule in a list: its name, the merchant it sets, or what it matches. A gift rule
 * is only "Gift rule": its name and what it matches are for whoever opens it.
 */
export function ruleTitle(definition: RuleDefinition): string {
  const { merchant, gift } = ruleActions(definition);
  if (gift) return "Gift rule";
  if (definition.name) return definition.name;
  if (merchant) return merchant;
  const when = definition.when;
  if ("merchant" in when && "equals" in when.merchant) return titleCase(when.merchant.equals);
  if ("descriptionKey" in when && "equals" in when.descriptionKey) return titleCase(when.descriptionKey.equals);
  return describePredicate(when);
}

/** A gift rule's dates, and whether it is on now, has yet to start, or is over. */
export function giftRuleWhen(definition: RuleDefinition, now = today()): { dates: string; status: string; active: boolean } | null {
  const parts = giftRuleParts(definition);
  if (!parts) return null;
  const dates = parts.from === parts.to ? formatDate(parts.from) : formatRange(parts.from, parts.to);
  if (now < parts.from) return { dates, status: `Starts ${formatDate(parts.from)}`, active: false };
  if (now > parts.to) return { dates, status: "Ended", active: false };
  return { dates, status: "Active", active: true };
}
