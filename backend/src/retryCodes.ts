/** Delivery-failure codes (from status webhooks) where a later resend may succeed. */
export const RETRYABLE_DELIVERY_CODES = new Set([130429, 131000, 131016, 131049, 131056, 133004]);
