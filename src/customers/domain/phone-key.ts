/**
 * T-07 — canonical key used for customer phone uniqueness.
 *
 * The customer record keeps the user's display value in `phone`.  This
 * helper produces the comparison value used by the PostgreSQL STORED
 * expression (`regexp_replace(phone, '[^0-9+]', '', 'g')`).  Keeping the
 * implementation in the domain layer lets the in-memory and PostgreSQL
 * adapters share the same semantics without importing an ORM or HTTP code.
 */

/**
 * Remove formatting characters from a phone while preserving digits and a
 * leading `+`.  The operation is deterministic and does not mutate input.
 * Validation of whether the display value is a valid phone belongs to the
 * Customer aggregate; this function only derives its uniqueness key.
 */
export function normalizePhoneKey(phone: string): string {
  return phone.toLowerCase().replace(/[^0-9+]/g, '');
}

/** Alias matching the data-model terminology used by persistence adapters. */
export const phoneKeyFor = normalizePhoneKey;
