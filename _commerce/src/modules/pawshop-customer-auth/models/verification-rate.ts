import { model } from '@medusajs/framework/utils'

// Sliding-window counter for verification-code request rate limiting.
//
// One row per (scope, key): `scope` is `email` or `ip`, `key` is the normalized
// value. The middleware appends a new window row per request and prunes expired
// rows, then counts the in-window rows to enforce the cooldown + hourly caps.
// This table holds only request timestamps — never an email address's content in
// a way that maps to a customer, and never a code/token.
export const VerificationRate = model.define('VerificationRate', {
  id: model.id({ prefix: 'vrate' }).primaryKey(),
  scope: model.text(),
  scope_key: model.text(),
  requested_at: model.dateTime(),
}).indexes([
  {
    name: 'IDX_verification_rate_scope_key_time',
    on: ['scope', 'scope_key', 'requested_at'],
  },
])
