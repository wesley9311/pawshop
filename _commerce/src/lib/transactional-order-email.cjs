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

// ---------------------------------------------------------------------------
// Customer-facing configuration (env-overridable, with safe defaults).
//
// These are the two tunables a store operator may want to change without a code
// deploy: the support address printed in every notification, and the display
// name shown on the "From" line. Both read from the process environment with a
// hard-coded fallback so the emails work even when the env is unset, and both
// are validated so a malformed value cannot inject a header line or a broken
// address into a customer email.
//
//   PAWSHOP_SUPPORT_EMAIL  →  the "contact us" address (default 504533680@qq.com,
//                             switch to support@pawlivora.com without a deploy)
//   PAWSHOP_EMAIL_FROM_NAME → the human-readable sender name (default Pawlivora)
const SUPPORT_EMAIL_DEFAULT = '504533680@qq.com';
const FROM_NAME_DEFAULT = 'Pawlivora';
const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i;

function readSupportEmail(environment = process.env) {
  const value = environment && typeof environment.PAWSHOP_SUPPORT_EMAIL === 'string'
    ? environment.PAWSHOP_SUPPORT_EMAIL.trim()
    : '';
  return EMAIL_ADDRESS_PATTERN.test(value) ? value : SUPPORT_EMAIL_DEFAULT;
}

function readFromName(environment = process.env) {
  const value = environment && typeof environment.PAWSHOP_EMAIL_FROM_NAME === 'string'
    ? environment.PAWSHOP_EMAIL_FROM_NAME.trim()
    : '';
  if (!value || /[\r\n]/.test(value)) return FROM_NAME_DEFAULT;
  return value;
}

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

  // The shipping address is flattened into exactly the fields the delivered
  // email needs. Phone/company/extra sensitive fields are deliberately NOT read:
  // a delivery notice only needs to confirm *where* it went, not who or how to
  // reach them.
  const address = order.shipping_address && typeof order.shipping_address === 'object'
    ? order.shipping_address
    : null;
  const shippingAddress = address ? {
    name: [address.first_name, address.last_name].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim() || null,
    address1: typeof address.address_1 === 'string' && address.address_1.trim() ? address.address_1.trim() : null,
    city: typeof address.city === 'string' && address.city.trim() ? address.city.trim() : null,
    province: typeof address.province === 'string' && address.province.trim() ? address.province.trim() : null,
    postalCode: typeof address.postal_code === 'string' && address.postal_code.trim() ? address.postal_code.trim() : null,
    country: typeof address.country_code === 'string' && address.country_code.trim() ? address.country_code.trim().toUpperCase() : null,
  } : null;

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
    shippingAddress,
  };
}

// Format a monetary amount with its currency code. No locale assumptions: this
// is a plain, deterministic rendering for a text email.
function formatMoney(amount, currency) {
  if (!Number.isFinite(amount)) return null;
  return `${currency} ${amount.toFixed(2)}`;
}

// Escape a value before it is interpolated into HTML. Every dynamic field in an
// email is ultimately customer- or operator-entered, so it is treated as
// untrusted text and escaped, never emitted as markup. This is a defense in
// depth on top of the field-level validation already applied by normalizeOrder
// and the tracking helpers: even a value that slipped through as plain text can
// not become an element or attribute.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The shared page chrome for every notification's HTML. It is deliberately
// small and self-contained: inline styles only (no external stylesheet), a
// centred brand mark with a light divider, and a footer that is visually
// de-emphasised. No marketing banner, background image, external logo, or
// layout dependency that a typical mail client would strip or break.
const BRAND_NAME = 'Pawlivora';

function htmlPage({ title, subtitle, bodyHtml, supportEmail }) {
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>', escapeHtml(title), '</title>',
    '</head>',
    '<body style="margin:0;padding:0;background-color:#f7f7f7;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f7f7;">',
    '<tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#ffffff;border-radius:8px;">',
    '<tr><td style="padding:28px 24px 0 24px;">',
    '<div style="text-align:center;font-size:20px;font-weight:700;color:#1a1a1a;letter-spacing:0.5px;">', escapeHtml(BRAND_NAME), '</div>',
    '</td></tr>',
    '<tr><td style="padding:12px 24px 0 24px;">',
    '<div style="border-top:1px solid #ececec;"></div>',
    '</td></tr>',
    '<tr><td style="padding:18px 24px 0 24px;">',
    '<div style="text-align:center;font-size:18px;font-weight:600;color:#1a1a1a;line-height:1.4;">', escapeHtml(title), '</div>',
    subtitle ? `<div style="text-align:center;font-size:14px;color:#6b7280;line-height:1.5;margin-top:6px;">${escapeHtml(subtitle)}</div>` : '',
    '</td></tr>',
    '<tr><td style="padding:20px 24px 0 24px;">',
    bodyHtml,
    '</td></tr>',
    '<tr><td style="padding:24px 24px 28px 24px;">',
    '<div style="border-top:1px solid #ececec;margin-bottom:20px;"></div>',
    '<div style="text-align:center;font-size:13px;color:#9ca3af;line-height:1.6;">',
    '<div>Need help with your order?</div>',
    '<div><a href="mailto:', escapeHtml(supportEmail), '" style="color:#6b7280;">', escapeHtml(supportEmail), '</a></div>',
    '</div>',
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('');
}

// One detail row in the order summary. The label/value pair is left-aligned and
// only rendered when a value is present, so a missing field never produces a
// dangling "Order number:" line. A short label sits to the left of its value;
// long, multi-line fields (the items list, a delivery address) instead use the
// stacked variant below so they do not force a wide, cramped two-column layout
// on a narrow mobile viewport.
function detailRow(label, value) {
  if (value == null || value === '') return '';
  return [
    '<tr>',
    '<td style="padding:5px 0;font-size:14px;color:#6b7280;white-space:nowrap;vertical-align:top;padding-right:16px;">', escapeHtml(label), '</td>',
    '<td style="padding:5px 0;font-size:14px;color:#1a1a1a;">', escapeHtml(value), '</td>',
    '</tr>',
  ].join('');
}

// A detail row whose label is stacked above its value (label on its own line,
// value on the next). Used for fields that may be long or contain several
// segments — the items list and the delivery address — so the value wraps
// naturally instead of being squeezed next to a fixed-width label on mobile.
function detailRowStacked(label, value) {
  if (value == null || value === '') return '';
  return [
    '<tr>',
    '<td style="padding:7px 0 2px 0;font-size:14px;color:#6b7280;">', escapeHtml(label), '</td>',
    '</tr>',
    '<tr>',
    '<td style="padding:0 0 7px 0;font-size:14px;color:#1a1a1a;line-height:1.6;">', escapeHtml(value), '</td>',
    '</tr>',
  ].join('');
}

// A stacked detail row whose value is already HTML-safe (it has been escaped
// exactly once by the caller). Used for the items list, whose cells join several
// fields that were each escaped individually; passing the whole line through
// escapeHtml again would double-escape the ampersands.
function detailRowStackedRaw(label, valueHtml) {
  if (valueHtml == null || valueHtml === '') return '';
  return [
    '<tr>',
    '<td style="padding:7px 0 2px 0;font-size:14px;color:#6b7280;">', escapeHtml(label), '</td>',
    '</tr>',
    '<tr>',
    '<td style="padding:0 0 7px 0;font-size:14px;color:#1a1a1a;line-height:1.6;">', valueHtml, '</td>',
    '</tr>',
  ].join('');
}

// The order-detail table shared by all three notifications. Each row is left
// aligned; tracking and the delivery address are only emitted for the messages
// that carry them and only when a real value is present.
function orderDetailsTable({ order, trackingLines, addressLines }) {
  const rows = [
    detailRow('Order number', order.publicOrderNumber),
    '',
  ];
  const itemLines = order.items.map((item) => {
    const total = formatMoney(item.total, order.currency);
    return escapeHtml(`${item.title}  x${item.quantity}${total ? `  ${total}` : ''}`);
  });
  if (itemLines.length > 0) {
    rows.push(detailRowStackedRaw('Items', itemLines.join('; ')));
  }
  rows.push(detailRow('Total', order.total != null ? formatMoney(order.total, order.currency) : null));
  rows.push(detailRow('Shipping method', order.shippingMethod));
  for (const line of trackingLines) rows.push(line);
  for (const line of addressLines) rows.push(line);

  const body = rows.filter(Boolean).join('');
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">',
    body,
    '</table>',
  ].join('');
}

// The per-type heading and subtitle. The status heading is centred; the subtitle
// is a short, honest summary of what the event guarantees — never a promise of
// a state that is not stored.
const HTML_COPY = {
  [NOTIFICATION_TYPES.ORDER_CONFIRMED]: {
    title: 'Order confirmed',
    subtitle: 'We have received your order and it is being processed.',
  },
  [NOTIFICATION_TYPES.ORDER_SHIPPED]: {
    title: 'Order shipped',
    subtitle: 'Your order is on its way.',
  },
  [NOTIFICATION_TYPES.ORDER_DELIVERED]: {
    title: 'Order delivered',
    subtitle: 'Your order has been delivered.',
  },
};

// Build the HTML rendering for one notification. This mirrors the plain-text
// body exactly: it re-validates tracking, flattens the address to the same safe
// fields, and never renders a value the event does not guarantee. The returned
// string is a complete HTML document; it is passed to buildMessage as the
// multipart/alternative HTML part alongside the existing plain-text body.
function buildOrderHtml(type, order, tracking, supportEmail) {
  const copy = HTML_COPY[type];
  if (!copy) return null;

  const trackingNumber = safeTrackingNumber(tracking?.trackingNumber);
  const trackingUrl = safeTrackingUrl(tracking?.trackingUrl);

  const trackingLines = [];
  if (trackingNumber) trackingLines.push(detailRow('Tracking number', trackingNumber));
  if (trackingUrl) trackingLines.push(detailRow('Track your package', trackingUrl));

  const addressLines = [];
  const address = order.shippingAddress;
  if (type === NOTIFICATION_TYPES.ORDER_DELIVERED && address && (address.name || address.address1 || address.city)) {
    const lines = [];
    if (address.name) lines.push(address.name);
    if (address.address1) lines.push(address.address1);
    const locality = [address.city, address.province].filter(Boolean).join(', ');
    if (locality) lines.push(locality);
    if (address.postalCode) lines.push(address.postalCode);
    if (address.country) lines.push(address.country);
    addressLines.push(detailRowStacked('Delivered to', lines.join(', ')));
  }

  const bodyHtml = orderDetailsTable({ order, trackingLines, addressLines });

  return htmlPage({
    title: copy.title,
    subtitle: copy.subtitle,
    bodyHtml,
    supportEmail,
  });
}

// The support contact block every notification shares. It is a single, safe
// address (validated on the way in); never the relay account or any credential.
function supportContactLines(supportEmail) {
  return [
    '',
    'Questions? Reply to this email or contact us at ' + supportEmail + '.',
  ];
}

// Build the plain-text body for each notification. The bodies are deliberately
// small and only assert what the triggering event guarantees.

function buildConfirmedBody(order, supportEmail) {
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
    ...supportContactLines(supportEmail),
    '',
    'Thank you for shopping with PawShop.',
  );
  return lines.join('\n');
}

function buildShippedBody(order, tracking, supportEmail) {
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
  if (order.shippingMethod) {
    lines.push('', `Shipping method: ${order.shippingMethod}`);
  }
  if (trackingNumber) {
    lines.push('', `Tracking number: ${trackingNumber}`);
  }
  if (trackingUrl) {
    lines.push(`Track your package: ${trackingUrl}`);
  }
  lines.push(
    ...supportContactLines(supportEmail),
    '',
    'Thank you for shopping with PawShop.',
  );
  return lines.join('\n');
}

function buildDeliveredBody(order, supportEmail) {
  const lines = [
    'Your PawShop order has been delivered.',
    '',
    `Order number: ${order.publicOrderNumber}`,
  ];
  // A delivery notice confirms *where* it went. Only the safe, non-sensitive
  // address fields are printed — never a phone number or other contact detail.
  const address = order.shippingAddress;
  if (address && (address.name || address.address1 || address.city)) {
    lines.push('', 'Delivered to:');
    if (address.name) lines.push(address.name);
    if (address.address1) lines.push(address.address1);
    const locality = [address.city, address.province].filter(Boolean).join(', ');
    if (locality) lines.push(locality);
    if (address.postalCode) lines.push(address.postalCode);
    if (address.country) lines.push(address.country);
  }
  lines.push(
    '',
    'We hope you and your pet enjoy it!',
    ...supportContactLines(supportEmail),
    '',
    'Thank you for shopping with PawShop.',
  );
  return lines.join('\n');
}

const SUBJECTS = {
  [NOTIFICATION_TYPES.ORDER_CONFIRMED]: 'Your Pawlivora order is confirmed',
  [NOTIFICATION_TYPES.ORDER_SHIPPED]: 'Your Pawlivora order has shipped',
  [NOTIFICATION_TYPES.ORDER_DELIVERED]: 'Your Pawlivora order has been delivered',
};

// Assemble the full RFC 5322 message for one notification. Returns null when the
// order lacks the minimum the message needs (an address and a public number).
//
// `from` is the envelope/return address (the bare mailbox); `fromName` is the
// human-readable display name put on the "From:" header. They are kept apart so
// the operator can brand the sender ("Pawlivora") without ever touching the SMTP
// account that actually authenticates and sends.
function buildOrderMessage({ type, order, tracking = {}, from, fromName = FROM_NAME_DEFAULT, supportEmail = SUPPORT_EMAIL_DEFAULT, now = new Date() }) {
  if (!order || !order.email || !order.publicOrderNumber) return null;

  let body;
  if (type === NOTIFICATION_TYPES.ORDER_CONFIRMED) {
    body = buildConfirmedBody(order, supportEmail);
  } else if (type === NOTIFICATION_TYPES.ORDER_SHIPPED) {
    body = buildShippedBody(order, tracking, supportEmail);
  } else if (type === NOTIFICATION_TYPES.ORDER_DELIVERED) {
    body = buildDeliveredBody(order, supportEmail);
  } else {
    return null;
  }

  // The plain-text body is always produced; the HTML part is a richer
  // alternative for capable clients. If HTML cannot be built (it always can for
  // a valid type), the message still falls back to text/plain.
  const html = buildOrderHtml(type, order, tracking, supportEmail);

  // Brand the display name without changing the envelope sender. The `fromName`
  // is already validated to contain no line break, so this is a safe header.
  const displayFrom = fromName && !/[\r\n]/.test(fromName) ? `${fromName} <${from}>` : from;

  return buildMessage({
    from: displayFrom,
    to: order.email,
    subject: SUBJECTS[type],
    body,
    html,
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
  fromName = FROM_NAME_DEFAULT,
  supportEmail = SUPPORT_EMAIL_DEFAULT,
  send = sendMessage,
  sendOptions = {},
}) {
  if (!credentials) return { sent: false, reason: 'no email relay is configured' };
  if (!order || !order.email) return { sent: false, reason: 'order has no customer email' };

  const message = buildOrderMessage({ type, order, tracking, from: credentials.from, fromName, supportEmail });
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
  SUPPORT_EMAIL_DEFAULT,
  FROM_NAME_DEFAULT,
  buildIdempotencyKey,
  buildOrderMessage,
  buildOrderHtml,
  classifySmtpError,
  computeNextAttemptAt,
  decideClaim,
  deliverOrderEmail,
  escapeHtml,
  formatMoney,
  isLeaseExpired,
  isRetryable,
  isUniqueViolation,
  normalizeOrder,
  readFromName,
  readSupportEmail,
  safeTrackingNumber,
  safeTrackingUrl,
  shouldSendNotification,
};
