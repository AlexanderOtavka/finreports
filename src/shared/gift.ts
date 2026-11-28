import type { TxnDto } from "./api.js";

/**
 * Gifts, on the honor system: a gift's merchant stays out of the lists, the charts and search,
 * where anyone glancing at the app would see it, and shows in the transaction's own sheet, for
 * whoever opens it.
 */

/** What a gift's merchant reads as in lists and charts. */
export const GIFT_LABEL = "Gift";
/** Every gift is one "merchant" in the reports, so none gives another away. */
export const GIFT_KEY = "gift";

/** The merchant a list or a chart shows. */
export const listMerchant = (t: Pick<TxnDto, "gift" | "merchant">): string => (t.gift ? GIFT_LABEL : t.merchant);
/** The merchant key a chart groups by. */
export const listMerchantKey = (t: Pick<TxnDto, "gift" | "merchantKey">): string => (t.gift ? GIFT_KEY : t.merchantKey);

/** Whether `source` (a `giftSource`) marks a gift. */
export const isGiftSource = (source: string | null): boolean => source !== null && source !== "manual:off";

/** Marked as a gift, or unmarked, from `source`. */
export const withGift = (t: TxnDto, source: string | null): TxnDto => ({ ...t, gift: isGiftSource(source), giftSource: source });
