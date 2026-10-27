import { z } from "zod";
import { descriptionKey, merchantKey, normalizeText } from "./merchant.js";

/**
 * Rules are data: a predicate over a transaction and an action. Predicates look at the
 * merchant, the description (as written, or reduced to its `descriptionKey`), the account and
 * the amount, combined with `all`/`any`/`not`. New predicate kinds are added here (schema +
 * evaluator) without touching storage; `rule_version.definition` keeps every version as it was
 * written.
 *
 * - Schema 1 sets a category: `then: { categoryId }`.
 * - Schema 2 sets a category, a merchant, or both: `then: { categoryId?, merchant? }`. Setting
 *   the merchant fills in one the backend does not have (the payee of an imported bank
 *   statement); it never renames a merchant the backend knows.
 * - A gift rule (schema 2, `then: { gift: true }`) marks what it matches as a gift: the
 *   transaction still counts, but its merchant is hidden from everyone but the rule's maker. It
 *   is meant for one purchase or a few, so it matches a few dates (`date`), and optionally what
 *   the merchant or the description contains (`giftRule`).
 */

const textMatch = z.union([
  z.object({ equals: z.string().min(1) }).strict(),
  z.object({ contains: z.string().min(1) }).strict(),
]);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date is YYYY-MM-DD");

export type TextMatch = z.infer<typeof textMatch>;

export type Predicate =
  | { merchant: TextMatch }
  | { description: TextMatch }
  | { descriptionKey: TextMatch }
  | { account: TextMatch }
  | { amount: { min?: number; max?: number } }
  /** Inclusive, `YYYY-MM-DD`. */
  | { date: { from?: string; to?: string } }
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ merchant: textMatch }).strict(),
    z.object({ description: textMatch }).strict(),
    z.object({ descriptionKey: textMatch }).strict(),
    z.object({ account: textMatch }).strict(),
    z
      .object({ amount: z.object({ min: z.number().optional(), max: z.number().optional() }).strict() })
      .strict(),
    z
      .object({ date: z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict() })
      .strict(),
    z.object({ all: z.array(predicateSchema).min(1) }).strict(),
    z.object({ any: z.array(predicateSchema).min(1) }).strict(),
    z.object({ not: predicateSchema }).strict(),
  ]),
);

const ruleV1 = z
  .object({
    schema: z.literal(1).default(1),
    name: z.string().max(200).optional(),
    when: predicateSchema,
    then: z.object({ categoryId: z.string().min(1) }).strict(),
  })
  .strict();

const ruleV2 = z
  .object({
    schema: z.literal(2),
    name: z.string().max(200).optional(),
    when: predicateSchema,
    then: z
      .object({
        categoryId: z.string().min(1).optional(),
        merchant: z.string().trim().min(1).max(200).optional(),
        gift: z.literal(true).optional(),
      })
      .strict()
      .refine((t) => t.categoryId !== undefined || t.merchant !== undefined || t.gift, "a rule sets a category, a merchant, or both, or marks a gift"),
  })
  .strict();

export const ruleDefinitionSchema = z.union([ruleV2, ruleV1]);

export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;

/** What a rule sets; null for what it leaves alone. */
export function ruleActions(definition: RuleDefinition): { categoryId: string | null; merchant: string | null; gift: boolean } {
  return {
    categoryId: definition.then.categoryId ?? null,
    merchant: definition.schema === 2 ? (definition.then.merchant ?? null) : null,
    gift: definition.schema === 2 && definition.then.gift === true,
  };
}

/** The fields of a transaction a predicate can look at. */
export interface RuleSubject {
  merchant: string | null;
  description: string;
  accountName: string | null;
  /** Signed: negative is money out. */
  amount: number;
  /** `YYYY-MM-DD`; a date predicate matches nothing without one. */
  date?: string;
}

function matchText(match: TextMatch, value: string): boolean {
  const v = normalizeText(value);
  if ("equals" in match) return v === normalizeText(match.equals);
  return v.includes(normalizeText(match.contains));
}

export function evaluate(predicate: Predicate, txn: RuleSubject): boolean {
  if ("merchant" in predicate) return matchText(predicate.merchant, merchantKey(txn.merchant, txn.description));
  if ("description" in predicate) return matchText(predicate.description, txn.description);
  if ("descriptionKey" in predicate) return matchText(predicate.descriptionKey, descriptionKey(txn.description));
  if ("account" in predicate) return matchText(predicate.account, txn.accountName ?? "");
  if ("amount" in predicate) {
    const { min, max } = predicate.amount;
    return (min === undefined || txn.amount >= min) && (max === undefined || txn.amount <= max);
  }
  if ("date" in predicate) {
    const { from, to } = predicate.date;
    if (txn.date === undefined) return false;
    return (from === undefined || txn.date >= from) && (to === undefined || txn.date <= to);
  }
  if ("all" in predicate) return predicate.all.every((p) => evaluate(p, txn));
  if ("any" in predicate) return predicate.any.some((p) => evaluate(p, txn));
  if ("not" in predicate) return !evaluate(predicate.not, txn);
  return false;
}

/** The rule the "Always categorize <merchant> as X" toggle creates. */
export function merchantRule(merchant: string | null, description: string, categoryId: string): RuleDefinition {
  return merchantKeyRule(merchantKey(merchant, description), categoryId);
}

export function merchantKeyRule(key: string, categoryId: string): RuleDefinition {
  return { schema: 1, when: { merchant: { equals: key } }, then: { categoryId } };
}

/**
 * The rule the rules builder proposes: every transaction whose description reduces to `key`
 * gets this merchant and this category.
 */
export function descriptionKeyRule(key: string, then: { merchant?: string; categoryId?: string }): RuleDefinition {
  return {
    schema: 2,
    when: { descriptionKey: { equals: key } },
    then: {
      ...(then.merchant ? { merchant: then.merchant } : {}),
      ...(then.categoryId ? { categoryId: then.categoryId } : {}),
    },
  };
}

/**
 * The rule the sheet saves: when `when`, set this merchant and this category. Schema 1 when it
 * sets only a category (as "always categorize" always has), schema 2 when it sets a merchant;
 * null when it sets nothing.
 */
export function ruleFor(when: Predicate, then: { merchant?: string | null; categoryId?: string | null }): RuleDefinition | null {
  if (then.merchant) return { schema: 2, when, then: { merchant: then.merchant, ...(then.categoryId ? { categoryId: then.categoryId } : {}) } };
  if (then.categoryId) return { schema: 1, when, then: { categoryId: then.categoryId } };
  return null;
}

/**
 * The gift rule: purchases from `from` to `to` (inclusive) whose merchant or description
 * contains `contains`, or every purchase in those dates without it.
 */
export function giftRule(input: { from: string; to: string; contains?: string; name?: string }): RuleDefinition {
  const dates: Predicate = { date: { from: input.from, to: input.to } };
  const text = input.contains?.trim();
  return {
    schema: 2,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
    when: text ? { all: [dates, { any: [{ merchant: { contains: text } }, { description: { contains: text } }] }] } : dates,
    then: { gift: true },
  };
}

/** The dates and the text of a gift rule made by `giftRule`, to edit it; null for another shape. */
export function giftRuleParts(definition: RuleDefinition): { from: string; to: string; contains: string } | null {
  const when = definition.when;
  const dates = "date" in when ? when : "all" in when && when.all[0] && "date" in when.all[0] ? when.all[0] : null;
  if (!dates || !dates.date.from || !dates.date.to) return null;
  let contains = "";
  if ("all" in when) {
    const any = when.all[1];
    const first = any && "any" in any ? any.any[0] : undefined;
    if (when.all.length !== 2 || !first || !("merchant" in first) || !("contains" in first.merchant)) return null;
    contains = first.merchant.contains;
  }
  return { from: dates.date.from, to: dates.date.to, contains };
}
