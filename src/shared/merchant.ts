/**
 * Merchant identity for rules and suggestions.
 *
 * A transaction's merchant is the backend's cleaned merchant name when there is one. Raw card
 * descriptions ("SQ *SUDS LAUNDRY 8832 BROOKLYN NY") are reduced to a stable key by dropping
 * processor prefixes, store numbers, card-network noise, and a trailing city/state, so that
 * every visit to the same shop gets the same key.
 */

const PROCESSOR_PREFIXES = [
  /^checkcard\s+\d{4}\s+/i,
  /^pos\s+(debit|purchase)\s+/i,
  /^debit\s+card\s+purchase\s+/i,
  /^purchase\s+authorized\s+on\s+\d{2}\/\d{2}\s+/i,
  /^recurring\s+/i,
  /^(sq|tst|sp|pp|py|in|dd|par|pmnt)\s*\*\s*/i,
  /^paypal\s*\*\s*/i,
];

const TRAILING_NOISE = [
  /\s+x{2,}\d+$/i, // masked card numbers
  /\s+\d{3}-?\d{3}-?\d{4}$/, // phone numbers
  /\s+[A-Za-z .]+\s+(NY|NJ|CA|MA|IL|WA|PA|DC|TX|OR|CO|FL)$/, // "NEW YORK NY"
  /\s+(NY|NJ|CA|MA|IL|WA|PA|DC|TX|OR|CO|FL)$/,
];

/** Lowercase, collapse whitespace, strip punctuation that varies between statements. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9&+ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reduces a raw description to the merchant it names, best effort. */
export function cleanDescription(raw: string): string {
  let value = raw.trim();
  for (const prefix of PROCESSOR_PREFIXES) value = value.replace(prefix, "");
  // Cut at an embedded reference such as "AMZN Mktp US*2K4L19XR3" or "UBER *EATS".
  value = value.replace(/\*[A-Z0-9]{6,}.*$/i, "");
  value = value.replace(/\s+#\s*\d+.*$/, "");
  for (let i = 0; i < 2; i += 1) {
    for (const noise of TRAILING_NOISE) value = value.replace(noise, "");
  }
  value = value.replace(/\s+\d{3,}\b.*$/, "");
  value = value.replace(/\s{2,}/g, " ").trim();
  return value || raw.trim();
}

/** The display name of a transaction's merchant. */
export function merchantDisplay(merchant: string | null | undefined, description: string): string {
  if (merchant && merchant.trim()) return merchant.trim();
  const cleaned = cleanDescription(description);
  // Raw descriptions are usually SHOUTING; title-case them for display.
  return cleaned === cleaned.toUpperCase()
    ? cleaned.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
    : cleaned;
}

/** The key rules and suggestions match on. */
export function merchantKey(merchant: string | null | undefined, description: string): string {
  return normalizeText(merchantDisplay(merchant, description));
}
