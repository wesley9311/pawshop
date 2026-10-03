'use strict';

// Pure claim-decision helpers for customer registration.
//
// These are lifted out of the store `customers` route so the decision logic is
// unit-testable without booting Medusa. The route keeps only the I/O: resolve the
// verified email against existing customers, then either create a new account or
// upgrade the matching guest customer in place, and record the audit row.
//
// The core rule (a guest customer must be upgraded in place, never duplicated)
// is driven by Medusa's own unique index `IDX_customer_email_has_account_unique`
// on `customer(email, has_account)`: an email may hold at most one guest row and
// one account row. Creating a fresh account for an email that already has a guest
// row would leave the guest row orphaned with its historical orders.

// Normalize an email for matching: trim + lowercase. This is the same
// normalization the emailpass provider uses for its `entity_id`, so a customer
// registering as "Buyer@Example.com" matches a guest created as
// "buyer@example.com".
function normalizeEmail(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isClaimableEmail(raw) {
  return EMAIL_PATTERN.test(normalizeEmail(raw));
}

// Decide what the registration must do, given the set of existing customers
// matching the normalized email. Returns one of:
//
//   { kind: 'create' }                          no existing customer → create new
//   { kind: 'claim', customerId }               exactly one guest customer → upgrade it
//   { kind: 'already_claimed', customerId }     exactly one account customer → refuse (idempotent no-op)
//   { kind: 'conflict', count }                 >1 customer for the email → stop, do not auto-merge
//
// `existing` is an array of `{ id, has_account }` for the email. The function is
// pure: it never queries, never writes, never mutates its input.
function decideClaim(existing) {
  const list = Array.isArray(existing) ? existing : [];
  if (list.length === 0) return { kind: 'create' };

  if (list.length > 1) return { kind: 'conflict', count: list.length };

  const only = list[0];
  if (only && only.has_account === true) {
    return { kind: 'already_claimed', customerId: only.id };
  }
  if (only && only.has_account === false) {
    return { kind: 'claim', customerId: only.id };
  }
  // A customer row without a clear has_account flag is ambiguous — stop rather
  // than guess. In practice Medusa always sets has_account.
  return { kind: 'conflict', count: list.length };
}

module.exports = {
  normalizeEmail,
  isClaimableEmail,
  decideClaim,
};
