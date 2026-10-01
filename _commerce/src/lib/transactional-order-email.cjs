'use strict';

// Customer transactional email for the order-notification closed loop.
//
// This module is the single place that turns a real order into a customer
// email. It exists so the three subscribers (order-confirmed / order-shipped /
// order-delivered) stay thin: they resolve the event into an order and hand it
// here, and this module does every remaining step — derive the idempotency key,
// validate the tracking URL, normalise the order into the template's inputs,
// build the message, and deliver it.
//
// Nothing here invents data. Every field is read from the order the caller
// already fetched with `getOrderDetailWorkflow`; the templates only say what a
// real event guarantees. A "shipped" email never promises a tracking number
// that is not there, and a "delivered" email never names a carrier state that
// Medusa does not store.

const { randomBytes } = require('node:crypto');
const { SmtpError, buildMessage, sendMessage } = require('./smtp-client.cjs');

// Postgres unique-violation. Medusa can wrap the driver error, so the whole
// cause chain is inspected rather than only the top-level error. Shared here so
// the module service and its tests see the same detection logic.
function isUniqueViolation(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current;
    if (candidate.code === '23505') return true;
    if (typeof candidate.message === 'string' && /duplicate key value violates unique constraint/i.test(candidate.message)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

// A shipment/delivery event carrying `no_notification` must be respected: the
// operator explicitly said "do not notify", so no email is sent. Extracted so
// the behaviour is unit-testable without booting Medusa.
function shouldSendNotification(noNotification) {
  return noNotification !== true;
}

// ---------------------------------------------------------------------------
// Send-state machine (pure decision logic).
//
// The durable row has a `status` in { pending, sending, sent, failed } and a
// lease (`claimed_at` + `lease_expires_at`). These pure helpers decide what the
// caller should do given the current row; the actual atomic SQL that changes the
// row lives in the notification module service. Keeping the decision here makes
// it unit-testable without a database.
//
// SEND_STATES is the authoritative status vocabulary.
const SEND_STATES = {
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  TERMINAL: 'terminal',
};

// How many send attempts a single notification may make before it is declared
// terminal. This bounds a permanently bad destination or a persistently broken
// relay so it does not retry forever. `attempt_count` counts every claim that
// reaches an actual SMTP send (not a claim that was skipped because another
// worker held the lease), so terminal is reached after the 5th failed send.
const MAX_ATTEMPTS = 5;

// Exponential-ish backoff between retries. The 1-based attempt number indexes
// this array. There are MAX_ATTEMPTS-1 = 4 retry slots, because the 5th (final)
// attempt is terminal: a failure on attempt 5 must not schedule a 6th send, so
// there is no backoff entry for it. The recovery job scans once a minute, so
// sub-minute steps would only add scan churn.
const BACKOFF_MS = [
  1 * 60 * 1000,   // after attempt 1 → retry in 1m
  5 * 60 * 1000,   // after attempt 2 → retry in 5m
  15 * 60 * 1000,  // after attempt 3 → retry in 15m
  60 * 60 * 1000,  // after attempt 4 → retry in 60m
  // (no entry for attempt 5: that failure is terminal, no retry)
];

// How long a worker may hold a row in `sending` before it is considered stale.
// A healthy SMTP session completes in seconds; this lease is long enough for a
// slow relay but short enough that a crashed worker does not block a redelivery
// forever.
const SEND_LEASE_MS = 5 * 60 * 1000;

// A lease is stale once `lease_expires_at` has passed. A `sending` row whose
// lease is stale was abandoned by a worker that died mid-send and may be claimed
// again.
function isLeaseExpired(leaseExpiresAt, now) {
  if (leaseExpiresAt == null) return true;
  const expiry = new Date(leaseExpiresAt).getTime();
  return !Number.isFinite(expiry) || expiry <= new Date(now).getTime();
}

// Decide what a claimant should do given the current row (or null when the row
// does not exist yet). The result is one of:
//
//   claim       this worker should take the row and attempt the send
//   skip_sent   the row is already in the terminal `sent` state — do not send
//   skip_terminal  the row reached a permanent terminal state — do not send
//   in_flight   another worker holds a live lease — do not send (yet)
//   wait_backoff  the row is `failed` but its backoff has not elapsed yet
function decideClaim(status, leaseExpiresAt, now) {
  if (status == null) return 'claim'; // no row yet; the INSERT will create it
  if (status === SEND_STATES.SENT) return 'skip_sent';
  if (status === SEND_STATES.TERMINAL) return 'skip_terminal';
  if (status === SEND_STATES.SENDING && !isLeaseExpired(leaseExpiresAt, now)) return 'in_flight';
  // pending, failed (backoff already elapsed), or a stale sending row are claimable.
  return 'claim';
}

// Classify an SMTP failure into a coarse, non-sensitive category. The relay's
// raw message can echo the recipient address or hints about the account, so only
// the category is ever persisted — never the message text.
//
//   auth        the relay refused the credentials (535)
//   recipient   the relay refused the recipient (4xx/5xx on RCPT TO)
//   connect     the relay could not be reached / TLS failed
//   transport   the session dropped mid-protocol
//   config      a bad input (host/port/credential shape) was caught locally
//   unknown     anything else
//
// The category alone does not decide retryability: an SMTP 4xx refusal is
// transient (try again), while a 5xx refusal is permanent. That split is made by
// `isRetryable`, which consults the numeric code in addition to the category.
function classifySmtpError(error) {
  if (error instanceof SmtpError) {
    if (error.stage === 'credentials') return 'auth';
    if (error.stage === 'connect' || error.stage === 'starttls') return 'connect';
    if (error.code === '550' || error.code === '551' || /^4\d\d$/.test(error.code) || /^5\d\d$/.test(error.code)) return 'recipient';
    if (error.stage === 'transport') return 'transport';
    if (error.stage === 'config') return 'config';
    return 'unknown';
  }
  return 'unknown';
}

// Whether a failed send may be retried. The rule separates transient faults
// (which a later attempt can succeed) from permanent ones (which never will):
//
//   retryable  — network/connect timeout, a transport drop, or an SMTP 4xx
//                recipient refusal (mailbox temporarily unavailable)
//   terminal   — a permanent 5xx recipient refusal, missing order, invalid
//                configuration, or an auth/credential failure
function isRetryable(category, error) {
  if (category === 'connect' || category === 'transport') return true;
  if (category === 'recipient') {
    // A 4xx recipient reply is transient; a 5xx (550/551) is permanent.
    const code = error instanceof SmtpError ? error.code : '';
    return /^4\d\d$/.test(code);
  }
  // auth, config, missing_order, credentials, unknown — do not retry blindly.
  return false;
}

// Compute the wall-clock time of the next allowed attempt for a 1-based attempt
// number, or null when no retry should be scheduled. `attempt` is the number of
// sends already attempted (the claim already incremented it). A failure on
// attempt 1..MAX_ATTEMPTS-1 schedules a retry at 1m/5m/15m/60m; a failure on
// attempt MAX_ATTEMPTS (the 5th) returns null — that attempt is terminal and
// must never schedule a 6th send.
function computeNextAttemptAt(attempt, now) {
  if (attempt >= MAX_ATTEMPTS) return null;
  const idx = Math.max(0, Math.min(attempt - 1, BACKOFF_MS.length - 1));
  return new Date(new Date(now).getTime() + BACKOFF_MS[idx]).toISOString();
}

// The three notifications Phase 1 sends. Each maps to one Medusa event and one
// idempotency key so a replayed event cannot send a second email.
const NOTIFICATION_TYPES = {
  ORDER_CONFIRMED: 'order_confirmed',
  ORDER_SHIPPED: 'shipped',
  ORDER_DELIVERED: 'delivered',
};

// Idempotency keys. The key is the entire deduplication mechanism upstream: the
// caller persists it in a unique-constrained table and a duplicate insert is the
// detection. It is deterministic (no random), so the same event always maps to
// the same key regardless of which process or retry builds it.
//
//   order confirmed  ->  order:<order_id>:order_confirmed
//   shipped          ->  fulfillment:<fulfillment_id>:shipped
//   delivered        ->  fulfillment:<fulfillment_id>:delivered
function buildIdempotencyKey(type, id) {
  const raw = String(id || '').trim();
  if (!raw) return null;
  if (/[\r\n\s]/.test(raw)) return null;
  switch (type) {
    case NOTIFICATION_TYPES.ORDER_CONFIRMED:
      return `order:${raw}:order_confirmed`;
    case NOTIFICATION_TYPES.ORDER_SHIPPED:
      return `fulfillment:${raw}:shipped`;
    case NOTIFICATION_TYPES.ORDER_DELIVERED:
      return `fulfillment:${raw}:delivered`;
    default:
      return null;
  }
}

// A tracking URL is operator-entered and stored in the database, so it is
// untrusted. Only an absolute http(s) URL is ever emitted — every other scheme
// (javascript:, data:, vbscript:) is dropped, which is the real injection risk
// even in a text/plain body. This mirrors PawSafe.link on the storefront: no
// host allowlist (carriers are many and change), but scheme-gated.
function safeTrackingUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/[\r\n]/.test(value)) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

// A tracking number is free text an operator typed; it is never interpreted,
// only echoed. A line break would let a crafted value inject an extra header or
// body line, so it is refused rather than passed through.
function safeTrackingNumber(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/[\r\n]/.test(value)) return null;
  return value.trim();
}

// Normalise a raw order (as returned by getOrderDetailWorkflow) into exactly the
// fields the templates need. Every value is read from the order; a missing value
// becomes null rather than a placeholder, so the template can decide whether to
// render a line at all.
function normalizeOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const currency = typeof order.currency_code === 'string' && order.currency_code ? order.currency_code.toUpperCase() : 'USD';
  const total = Number(order.total);
  const items = (Array.isArray(order.items) ? order.items : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      title: typeof item.title === 'string' ? item.title.trim() : '',
      quantity: Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1,
      total: Number(item.total),
    }))
    .filter((item) => item.title);

  const shippingMethod = (Array.isArray(order.shipping_methods) && order.shipping_methods[0])
    ? order.shipping_methods[0].name
    : null;

  return {
    orderId: typeof order.id === 'string' ? order.id : null,
    displayId: order.display_id != null ? Number(order.display_id) : null,
    email: typeof order.email === 'string' ? order.email.trim().toLowerCase() : null,
    publicOrderNumber: typeof order.public_order_number === 'string'
      ? order.public_order_number
      : null,
    currency,
    total: Number.isFinite(total) ? total : null,
    items,
    shippingMethod: typeof shippingMethod === 'string' && shippingMethod ? shippingMethod : null,
  };
}

// Format a monetary amount with its currency code. No locale assumptions: this
// is a plain, deterministic rendering for a text email.
function formatMoney(amount, currency) {
  if (!Number.isFinite(amount)) return null;
  return `${currency} ${amount.toFixed(2)}`;
}

// Build the plain-text body for each notification. The bodies are deliberately
// small and only assert what the triggering event guarantees.

function buildConfirmedBody(order) {
  const lines = [
    'Thank you for your order at PawShop!',
    '',
    `Order number: ${order.publicOrderNumber}`,
    '',
    'Items:',
  ];
  for (const item of order.items) {
    const total = formatMoney(item.total, order.currency) ?? '';
    lines.push(`  - ${item.title} x${item.quantity}${total ? `  ${total}` : ''}`);
  }
  if (order.shippingMethod) {
    lines.push('', `Shipping method: ${order.shippingMethod}`);
  }
  if (order.total != null) {
    lines.push(`Total: ${formatMoney(order.total, order.currency)}`);
  }
  lines.push(
    '',
    'We have received your order and it is being processed.',
    '',
    'You will receive another email once your order ships.',
    '',
    'Thank you for shopping with PawShop.',
  );
  return lines.join('\n');
}

function buildShippedBody(order, tracking) {
  // The tracking value is operator-entered and untrusted, so it is re-validated
  // here rather than trusted from the caller: a non-http(s) URL or a value with
  // a line break is dropped, never rendered into the body.
  const trackingNumber = safeTrackingNumber(tracking?.trackingNumber);
  const trackingUrl = safeTrackingUrl(tracking?.trackingUrl);
  const lines = [
    'Good news — your PawShop order has shipped!',
    '',
    `Order number: ${order.publicOrderNumber}`,
  ];
  if (trackingNumber) {
    lines.push('', `Tracking number: ${trackingNumber}`);
  }
  if (trackingUrl) {
    lines.push(`Track your package: ${trackingUrl}`);
  }
  lines.push(
    '',
    'Thank you for shopping with PawShop.',
  );
  return lines.join('\n');
}

function buildDeliveredBody(order) {
  return [
    'Your PawShop order has been delivered.',
    '',
    `Order number: ${order.publicOrderNumber}`,
    '',
    'We hope you and your pet enjoy it!',
    '',
    'Thank you for shopping with PawShop.',
  ].join('\n');
}

const SUBJECTS = {
  [NOTIFICATION_TYPES.ORDER_CONFIRMED]: 'Your PawShop order is confirmed',
  [NOTIFICATION_TYPES.ORDER_SHIPPED]: 'Your PawShop order has shipped',
  [NOTIFICATION_TYPES.ORDER_DELIVERED]: 'Your PawShop order has been delivered',
};

// Assemble the full RFC 5322 message for one notification. Returns null when the
// order lacks the minimum the message needs (an address and a public number).
function buildOrderMessage({ type, order, tracking = {}, from, now = new Date() }) {
  if (!order || !order.email || !order.publicOrderNumber) return null;

  let body;
  if (type === NOTIFICATION_TYPES.ORDER_CONFIRMED) {
    body = buildConfirmedBody(order);
  } else if (type === NOTIFICATION_TYPES.ORDER_SHIPPED) {
    body = buildShippedBody(order, tracking);
  } else if (type === NOTIFICATION_TYPES.ORDER_DELIVERED) {
    body = buildDeliveredBody(order);
  } else {
    return null;
  }

  return buildMessage({
    from,
    to: order.email,
    subject: SUBJECTS[type],
    body,
    messageId: `<${randomBytes(16).toString('hex')}@pawlivora.com>`,
    date: now.toUTCString(),
  });
}

// Deliver one notification. `send` is injectable so tests can assert delivery
// without a relay; production uses sendMessage. `credentials` is the validated
// relay config from readEmailCredentials. Returns a structured outcome so the
// subscriber can log "sent", "skipped (no address)", or "failed (relay refused)"
// — never claiming delivery when the relay refused the message.
async function deliverOrderEmail({
  type,
  order,
  tracking = {},
  credentials,
  send = sendMessage,
  sendOptions = {},
}) {
  if (!credentials) return { sent: false, reason: 'no email relay is configured' };
  if (!order || !order.email) return { sent: false, reason: 'order has no customer email' };

  const message = buildOrderMessage({ type, order, tracking, from: credentials.from });
  if (!message) return { sent: false, reason: 'order cannot be rendered for email' };

  try {
    await send({
      host: credentials.host,
      port: credentials.port,
      secure: credentials.secure,
      user: credentials.user,
      password: credentials.password,
      from: credentials.from,
      to: order.email,
      message,
      ...sendOptions,
    });
  } catch (error) {
    // `reason` is what may reach a log line, so it carries only the numeric SMTP
    // code and stage — never the relay's free text (which can echo the recipient
    // or hints about the account). The raw error is returned separately so the
    // caller can classify it into a coarse, non-sensitive category for storage.
    const code = error instanceof SmtpError && error.code ? ` (code ${error.code}, stage ${error.stage})` : '';
    return { sent: false, reason: `${error.message}${code}`, error };
  }
  return { sent: true, to: order.email };
}

module.exports = {
  NOTIFICATION_TYPES,
  SEND_LEASE_MS,
  SEND_STATES,
  MAX_ATTEMPTS,
  BACKOFF_MS,
  buildIdempotencyKey,
  buildOrderMessage,
  classifySmtpError,
  computeNextAttemptAt,
  decideClaim,
  deliverOrderEmail,
  formatMoney,
  isLeaseExpired,
  isRetryable,
  isUniqueViolation,
  normalizeOrder,
  safeTrackingNumber,
  safeTrackingUrl,
  shouldSendNotification,
};
