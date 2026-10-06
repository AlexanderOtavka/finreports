import { z } from "zod";
import { merchantKey, normalizeText } from "./merchant.js";

/**
 * Rules are data: a predicate over a transaction and an action. Version 1 knows merchant,
 * description, account and amount predicates, combined with `all`/`any`/`not`. New predicate
 * kinds are added here (schema + evaluator) without touching storage; `rule_version.definition`
 * keeps every version as it was written.
 */

const textMatch = z.union([
  z.object({ equals: z.string().min(1) }).strict(),
  z.object({ contains: z.string().min(1) }).strict(),
]);

export type TextMatch = z.infer<typeof textMatch>;

export type Predicate =
  | { merchant: TextMatch }
  | { description: TextMatch }
  | { account: TextMatch }
  | { amount: { min?: number; max?: number } }
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate };

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ merchant: textMatch }).strict(),
    z.object({ description: textMatch }).strict(),
    z.object({ account: textMatch }).strict(),
    z
      .object({ amount: z.object({ min: z.number().optional(), max: z.number().optional() }).strict() })
      .strict(),
    z.object({ all: z.array(predicateSchema).min(1) }).strict(),
    z.object({ any: z.array(predicateSchema).min(1) }).strict(),
    z.object({ not: predicateSchema }).strict(),
  ]),
);

export const ruleDefinitionSchema = z
  .object({
    schema: z.literal(1).default(1),
    name: z.string().max(200).optional(),
    when: predicateSchema,
    then: z.object({ categoryId: z.string().min(1) }).strict(),
  })
  .strict();

export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;

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
