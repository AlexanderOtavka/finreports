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
 */

const textMatch = z.union([
  z.object({ equals: z.string().min(1) }).strict(),
  z.object({ contains: z.string().min(1) }).strict(),
]);

export type TextMatch = z.infer<typeof textMatch>;

export type Predicate =
  | { merchant: TextMatch }
  | { description: TextMatch }
  | { descriptionKey: TextMatch }
  | { account: TextMatch }
  | { amount: { min?: number; max?: number } }
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
      .object({ categoryId: z.string().min(1).optional(), merchant: z.string().trim().min(1).max(200).optional() })
      .strict()
      .refine((t) => t.categoryId !== undefined || t.merchant !== undefined, "a rule sets a category, a merchant, or both"),
  })
  .strict();

export const ruleDefinitionSchema = z.union([ruleV2, ruleV1]);

export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;

/** What a rule sets; null for what it leaves alone. */
export function ruleActions(definition: RuleDefinition): { categoryId: string | null; merchant: string | null } {
  return {
    categoryId: definition.then.categoryId ?? null,
    merchant: definition.schema === 2 ? (definition.then.merchant ?? null) : null,
  };
}

/** The fields of a transaction a predicate can look at. */
export interface RuleSubject {
  merchant: string | null;
  description: string;
  accountName: string | null;
  /** Signed: negative is money out. */
  amount: number;
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
