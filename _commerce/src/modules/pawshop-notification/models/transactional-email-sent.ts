import { model } from '@medusajs/framework/utils'

// Durable send-state machine for customer transactional email.
//
// A customer notification must be sent at most once per real event *and* must
// survive a transient SMTP failure. Holding the state in process memory would
// lose it on every restart, so the state is a row. The unique index on
// `idempotency_key` makes each event claimable exactly once, and the `status`
// column records how far the send got:
//
//   pending    the event was seen, but no send attempt has started
//   sending    a worker holds a lease and is attempting the SMTP send now
//   sent       the relay accepted the message (terminal, success)
//   failed     the last attempt failed; a retry is scheduled via next_attempt_at
//   terminal   the row can never be delivered (permanent error, or max attempts)
//
// `sent` and `terminal` are the only terminal states. `failed` is recoverable:
// a transient SMTP error must not permanently consume the idempotency key, or a
// later redelivery would never send — a deterministic drop. The lease
// (`claimed_at` + `lease_expires_at`) lets a worker that dies mid-send be
// recovered: once the lease expires, another attempt may take the row over.
//
// `attempt_count` is the number of actual SMTP send attempts made (incremented
// on every successful claim, not on skips). Once it reaches MAX_ATTEMPTS, the
// row goes terminal so a permanently bad destination cannot retry forever.
//
// `notification_type` + `entity_id` are the only business-locating fields kept:
// together they name the real order or fulfillment to re-query on retry, so the
// recovery worker does not have to parse the idempotency key. Nothing sensitive
// is persisted: no customer email, no message body, no address, no tracking
// content, no SMTP credential. `error_category` is a coarse, non-sensitive
// classification (e.g. "auth", "connect", "recipient").
export const TransactionalEmailSent = model.define('TransactionalEmailSent', {
  id: model.id({ prefix: 'txnemail' }).primaryKey(),
  idempotency_key: model.text(),
  notification_type: model.text(),
  entity_id: model.text(),
  status: model.enum(['pending', 'sending', 'sent', 'failed', 'terminal']),
  attempt_count: model.number(),
  claimed_at: model.dateTime().nullable(),
  lease_expires_at: model.dateTime().nullable(),
  next_attempt_at: model.dateTime().nullable(),
  sent_at: model.dateTime().nullable(),
  error_category: model.text().nullable(),
  expires_at: model.dateTime(),
}).indexes([
  {
    name: 'IDX_transactional_email_sent_key_unique',
    on: ['idempotency_key'],
    unique: true,
  },
  {
    name: 'IDX_transactional_email_sent_status',
    on: ['status'],
  },
  {
    name: 'IDX_transactional_email_sent_lease_expires_at',
    on: ['lease_expires_at'],
  },
  {
    name: 'IDX_transactional_email_sent_next_attempt_at',
    on: ['next_attempt_at'],
  },
  {
    name: 'IDX_transactional_email_sent_expires_at',
    on: ['expires_at'],
  },
])
