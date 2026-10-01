'use strict';

// Customer transactional email for the order-notification closed loop.
//
// These tests pin the pure, unit-testable behaviour: idempotency keys are
// deterministic (a replayed event maps to the same key), templates only assert
// what the triggering event guarantees (a "shipped" email never promises a
// tracking number that is not there), a tracking URL is scheme-gated, and a
// failed SMTP send is never reported as sent. The SMTP relay itself is covered
// by email-channel.test.cjs; here `send` is injected so delivery outcomes can
// be asserted without a live relay.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SmtpError } = require('../src/lib/smtp-client.cjs');
const {
  NOTIFICATION_TYPES,
  SEND_STATES,
  MAX_ATTEMPTS,
  BACKOFF_MS,
  SUPPORT_EMAIL_DEFAULT,
  FROM_NAME_DEFAULT,
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
  readFromName,
  readSupportEmail,
  safeTrackingNumber,
  safeTrackingUrl,
  shouldSendNotification,
} = require('../src/lib/transactional-order-email.cjs');

const CREDENTIALS = {
  host: '127.0.0.1', port: 465, secure: true,
  user: 'owner@example.test', password: 'app-password-1234',
  from: 'shop@pawlivora.com',
};

const CONFIRMED_ORDER = {
  orderId: 'order_01ABC',
  displayId: 6,
  email: 'buyer@example.test',
  publicOrderNumber: 'PS-20260929-0006',
  currency: 'USD',
  total: 29.9,
  items: [
    { title: 'Corrugated Cat Lounger', quantity: 2, total: 29.9 },
  ],
  shippingMethod: 'Standard Shipping',
};

const SHIPPED_ORDER = {
  orderId: 'order_01ABC',
  displayId: 6,
  email: 'buyer@example.test',
  publicOrderNumber: 'PS-20260929-0006',
  currency: 'USD',
  total: 29.9,
  items: [
    { title: 'Corrugated Cat Lounger', quantity: 2, total: 29.9 },
  ],
  shippingMethod: 'Standard Shipping',
};

const DELIVERED_ORDER = {
  orderId: 'order_01ABC',
  displayId: 6,
  email: 'buyer@example.test',
  publicOrderNumber: 'PS-20260929-0006',
  currency: 'USD',
  total: 29.9,
  items: [
    { title: 'Corrugated Cat Lounger', quantity: 2, total: 29.9 },
  ],
  shippingMethod: 'Standard Shipping',
  shippingAddress: {
    name: 'Jane Buyer',
    address1: '123 Main St',
    city: 'New York',
    province: 'NY',
    postalCode: '10001',
    country: 'US',
  },
};

function decodeBase64Body(message) {
  const [, payload = ''] = message.split('\r\n\r\n');
  return Buffer.from(payload.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('idempotency keys', () => {
  it('is deterministic for the same order/fulfillment and event', () => {
    const a = buildIdempotencyKey(NOTIFICATION_TYPES.ORDER_CONFIRMED, 'order_01ABC');
    const b = buildIdempotencyKey(NOTIFICATION_TYPES.ORDER_CONFIRMED, 'order_01ABC');
    assert.equal(a, b);
    assert.equal(a, 'order:order_01ABC:order_confirmed');
  });

  it('distinguishes the three notification types', () => {
    const confirmed = buildIdempotencyKey(NOTIFICATION_TYPES.ORDER_CONFIRMED, 'order_01ABC');
    const shipped = buildIdempotencyKey(NOTIFICATION_TYPES.ORDER_SHIPPED, 'ful_01XYZ');
    const delivered = buildIdempotencyKey(NOTIFICATION_TYPES.ORDER_DELIVERED, 'ful_01XYZ');
    assert.equal(shipped, 'fulfillment:ful_01XYZ:shipped');
    assert.equal(delivered, 'fulfillment:ful_01XYZ:delivered');
    assert.notEqual(confirmed, shipped);
    assert.notEqual(shipped, delivered);
  });

  it('distinguishes two different fulfillments of the same event', () => {
    const one = buildIdempotencyKey(NOTIFICATION_TYPES.ORDER_SHIPPED, 'ful_01');
    const two = buildIdempotencyKey(NOTIFICATION_TYPES.ORDER_SHIPPED, 'ful_02');
    assert.notEqual(one, two);
  });

  it('refuses an empty or line-breaking id', () => {
    assert.equal(buildIdempotencyKey(NOTIFICATION_TYPES.ORDER_CONFIRMED, ''), null);
    assert.equal(buildIdempotencyKey(NOTIFICATION_TYPES.ORDER_CONFIRMED, 'a\nb'), null);
    assert.equal(buildIdempotencyKey('not_a_type', 'x'), null);
  });

  it('accepts any non-blank, non-line-breaking id as an order id', () => {
    assert.equal(buildIdempotencyKey(NOTIFICATION_TYPES.ORDER_CONFIRMED, 'unknown'), 'order:unknown:order_confirmed');
  });
});

describe('tracking URL safety', () => {
  it('accepts an absolute https tracking URL', () => {
    assert.equal(safeTrackingUrl('https://track.carrier.test/abc123'), 'https://track.carrier.test/abc123');
  });

  it('accepts an absolute http URL', () => {
    assert.equal(safeTrackingUrl('http://track.carrier.test/abc'), 'http://track.carrier.test/abc');
  });

  it('drops non-http(s) schemes (javascript:, data:, vbscript:)', () => {
    assert.equal(safeTrackingUrl('javascript:alert(1)'), null);
    assert.equal(safeTrackingUrl('data:text/html,<script>'), null);
    assert.equal(safeTrackingUrl('vbscript:msgbox'), null);
  });

  it('drops empty, non-string, and line-breaking values', () => {
    assert.equal(safeTrackingUrl(''), null);
    assert.equal(safeTrackingUrl(null), null);
    assert.equal(safeTrackingUrl(undefined), null);
    assert.equal(safeTrackingUrl('https://a.test/x\r\nBcc: evil@x'), null);
  });

  it('rejects a tracking number with a line break', () => {
    assert.equal(safeTrackingNumber('AB123'), 'AB123');
    assert.equal(safeTrackingNumber('x\r\ny'), null);
    assert.equal(safeTrackingNumber(''), null);
    assert.equal(safeTrackingNumber(null), null);
  });
});

describe('order normalisation', () => {
  it('lowercases the email and coerces numerics', () => {
    const order = normalizeOrder({
      id: 'order_1', display_id: 6, email: 'Buyer@Example.Test',
      currency_code: 'usd', total: '29.90',
      items: [{ title: 'Cat Lounger', quantity: 2, total: '29.90' }],
      shipping_methods: [{ name: 'Standard' }],
    });
    assert.equal(order.email, 'buyer@example.test');
    assert.equal(order.currency, 'USD');
    assert.equal(order.total, 29.9);
    assert.equal(order.items[0].quantity, 2);
  });

  it('flattens the shipping address into the safe summary fields', () => {
    const order = normalizeOrder({
      id: 'order_1', display_id: 6, email: 'b@e.test', total: 1,
      shipping_address: {
        first_name: 'Jane', last_name: 'Buyer', address_1: '123 Main St',
        address_2: 'Apt 4', city: 'New York', province: 'NY',
        postal_code: '10001', country_code: 'us', phone: '555-1234', company: 'Acme',
      },
    });
    assert.deepEqual(order.shippingAddress, {
      name: 'Jane Buyer', address1: '123 Main St', city: 'New York',
      province: 'NY', postalCode: '10001', country: 'US',
    });
    // phone / company / address_2 are deliberately dropped from the summary.
    assert.equal('phone' in order.shippingAddress, false);
    assert.equal('company' in order.shippingAddress, false);
    assert.equal('address2' in order.shippingAddress, false);
  });

  it('returns null for a non-object order', () => {
    assert.equal(normalizeOrder(null), null);
    assert.equal(normalizeOrder(undefined), null);
  });
});

describe('confirmed message', () => {
  it('contains the public order number, items, total and shipping method', () => {
    const message = buildOrderMessage({ type: NOTIFICATION_TYPES.ORDER_CONFIRMED, order: CONFIRMED_ORDER, from: CREDENTIALS.from });
    assert.ok(message);
    const body = decodeBase64Body(message);
    assert.match(body, /Order number: PS-20260929-0006/);
    assert.match(body, /Corrugated Cat Lounger x2/);
    assert.match(body, /USD 29\.90/);
    assert.match(body, /Standard Shipping/);
    assert.match(message, /^To: buyer@example\.test$/m);
  });

  it('carries the support contact line', () => {
    const message = buildOrderMessage({ type: NOTIFICATION_TYPES.ORDER_CONFIRMED, order: CONFIRMED_ORDER, from: CREDENTIALS.from });
    const body = decodeBase64Body(message);
    assert.match(body, new RegExp(`contact us at ${SUPPORT_EMAIL_DEFAULT}`));
  });

  it('never promises tracking or claims it shipped', () => {
    const message = buildOrderMessage({ type: NOTIFICATION_TYPES.ORDER_CONFIRMED, order: CONFIRMED_ORDER, from: CREDENTIALS.from });
    const body = decodeBase64Body(message);
    assert.doesNotMatch(body, /tracking/i);
    assert.doesNotMatch(body, /shipped/i);
  });
});

describe('shipped message', () => {
  it('shows the tracking number and URL only when both exist', () => {
    const message = buildOrderMessage({
      type: NOTIFICATION_TYPES.ORDER_SHIPPED,
      order: SHIPPED_ORDER,
      tracking: { trackingNumber: 'AB123', trackingUrl: 'https://track.carrier.test/AB123' },
      from: CREDENTIALS.from,
    });
    const body = decodeBase64Body(message);
    assert.match(body, /has shipped/);
    assert.match(body, /Tracking number: AB123/);
    assert.match(body, /https:\/\/track\.carrier\.test\/AB123/);
  });

  it('carries the shipping method and support contact', () => {
    const message = buildOrderMessage({
      type: NOTIFICATION_TYPES.ORDER_SHIPPED,
      order: SHIPPED_ORDER,
      tracking: {},
      from: CREDENTIALS.from,
    });
    const body = decodeBase64Body(message);
    assert.match(body, /Shipping method: Standard Shipping/);
    assert.match(body, new RegExp(`contact us at ${SUPPORT_EMAIL_DEFAULT}`));
  });

  it('omits the tracking lines entirely when there is no tracking', () => {
    const message = buildOrderMessage({
      type: NOTIFICATION_TYPES.ORDER_SHIPPED,
      order: SHIPPED_ORDER,
      tracking: { trackingNumber: null, trackingUrl: null },
      from: CREDENTIALS.from,
    });
    const body = decodeBase64Body(message);
    assert.match(body, /has shipped/);
    assert.doesNotMatch(body, /Tracking number/);
    assert.doesNotMatch(body, /track\./);
  });

  it('never fabricates a link when the URL is invalid', () => {
    const message = buildOrderMessage({
      type: NOTIFICATION_TYPES.ORDER_SHIPPED,
      order: SHIPPED_ORDER,
      tracking: { trackingNumber: 'AB123', trackingUrl: 'javascript:alert(1)' },
      from: CREDENTIALS.from,
    });
    const body = decodeBase64Body(message);
    assert.match(body, /Tracking number: AB123/);
    assert.doesNotMatch(body, /javascript:/);
    assert.doesNotMatch(body, /alert/);
  });
});

describe('delivered message', () => {
  it('says delivered and never invents a carrier state', () => {
    const message = buildOrderMessage({
      type: NOTIFICATION_TYPES.ORDER_DELIVERED,
      order: DELIVERED_ORDER,
      tracking: {},
      from: CREDENTIALS.from,
    });
    const body = decodeBase64Body(message);
    assert.match(body, /has been delivered/);
    assert.match(body, /Order number: PS-20260929-0006/);
    assert.doesNotMatch(body, /in transit|out for delivery|carrier/i);
  });

  it('prints the shipping address summary without extra sensitive fields', () => {
    const message = buildOrderMessage({
      type: NOTIFICATION_TYPES.ORDER_DELIVERED,
      order: DELIVERED_ORDER,
      tracking: {},
      from: CREDENTIALS.from,
    });
    const body = decodeBase64Body(message);
    assert.match(body, /Delivered to:/);
    assert.match(body, /Jane Buyer/);
    assert.match(body, /123 Main St/);
    assert.match(body, /New York, NY/);
    assert.match(body, /10001/);
    assert.match(body, /US/);
    // The address summary never leaks a phone number or other contact detail.
    assert.doesNotMatch(body, /phone|tel|555-|company/i);
  });

  it('carries the support contact line', () => {
    const message = buildOrderMessage({
      type: NOTIFICATION_TYPES.ORDER_DELIVERED,
      order: DELIVERED_ORDER,
      tracking: {},
      from: CREDENTIALS.from,
    });
    const body = decodeBase64Body(message);
    assert.match(body, new RegExp(`contact us at ${SUPPORT_EMAIL_DEFAULT}`));
  });
});

describe('message assembly guards', () => {
  it('refuses to build a message without an email or public order number', () => {
    assert.equal(buildOrderMessage({ type: NOTIFICATION_TYPES.ORDER_CONFIRMED, order: { ...CONFIRMED_ORDER, email: null }, from: CREDENTIALS.from }), null);
    assert.equal(buildOrderMessage({ type: NOTIFICATION_TYPES.ORDER_CONFIRMED, order: { ...CONFIRMED_ORDER, publicOrderNumber: null }, from: CREDENTIALS.from }), null);
    assert.equal(buildOrderMessage({ type: 'not_a_type', order: CONFIRMED_ORDER, from: CREDENTIALS.from }), null);
  });
});

describe('delivery orchestration', () => {
  it('sends one confirmation email', async () => {
    const sent = [];
    const result = await deliverOrderEmail({
      type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
      order: CONFIRMED_ORDER,
      credentials: CREDENTIALS,
      send: async (args) => { sent.push(args); },
    });
    assert.equal(result.sent, true);
    assert.equal(result.to, 'buyer@example.test');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'buyer@example.test');
  });

  it('does not claim a failed SMTP send as sent', async () => {
    const result = await deliverOrderEmail({
      type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
      order: CONFIRMED_ORDER,
      credentials: CREDENTIALS,
      send: async () => { throw new SmtpError('The mail server refused the credentials step.', { code: '535', stage: 'credentials' }); },
    });
    assert.equal(result.sent, false);
    assert.match(result.reason, /code 535/);
    // The raw error is returned so the caller can classify it into a coarse,
    // non-sensitive category (auth) without leaking the relay's message text.
    assert.equal(classifySmtpError(result.error), 'auth');
  });

  it('returns the raw error for classification on failure', async () => {
    const result = await deliverOrderEmail({
      type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
      order: CONFIRMED_ORDER,
      credentials: CREDENTIALS,
      send: async () => { throw new SmtpError('Could not reach the mail server.', { code: 'ECONNREFUSED', stage: 'connect' }); },
    });
    assert.equal(result.sent, false);
    assert.equal(classifySmtpError(result.error), 'connect');
  });

  it('skips safely when the order has no customer email', async () => {
    const sent = [];
    const result = await deliverOrderEmail({
      type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
      order: { ...CONFIRMED_ORDER, email: null },
      credentials: CREDENTIALS,
      send: async (args) => { sent.push(args); },
    });
    assert.equal(result.sent, false);
    assert.match(result.reason, /no customer email/);
    assert.equal(sent.length, 0);
  });

  it('reports a missing relay without attempting a send', async () => {
    const sent = [];
    const result = await deliverOrderEmail({
      type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
      order: CONFIRMED_ORDER,
      credentials: null,
      send: async (args) => { sent.push(args); },
    });
    assert.equal(result.sent, false);
    assert.match(result.reason, /no email relay/);
    assert.equal(sent.length, 0);
  });

  it('never puts the SMTP credential into the transmitted message', async () => {
    let captured;
    await deliverOrderEmail({
      type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
      order: CONFIRMED_ORDER,
      credentials: CREDENTIALS,
      send: async (args) => { captured = args.message; },
    });
    assert.doesNotMatch(captured, /app-password-1234/);
  });
});

describe('money formatting', () => {
  it('formats a fixed amount with its currency', () => {
    assert.equal(formatMoney(29.9, 'USD'), 'USD 29.90');
    assert.equal(formatMoney(NaN, 'USD'), null);
  });
});

describe('from display name', () => {
  it('brands the From header with the display name but keeps the envelope address', () => {
    const message = buildOrderMessage({
      type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
      order: CONFIRMED_ORDER,
      from: CREDENTIALS.from,
      fromName: 'Pawlivora',
    });
    // The From header carries the brand; the envelope sender is untouched (the
    // caller passes the bare mailbox to send() separately).
    assert.match(message, /^From: Pawlivora <shop@pawlivora\.com>$/m);
  });

  it('defaults to the brand name when fromName is omitted', () => {
    const message = buildOrderMessage({ type: NOTIFICATION_TYPES.ORDER_CONFIRMED, order: CONFIRMED_ORDER, from: CREDENTIALS.from });
    assert.match(message, new RegExp(`^From: ${FROM_NAME_DEFAULT} <shop@pawlivora\\.com>$`, 'm'));
  });

  it('never injects a line break through a crafted fromName', () => {
    const message = buildOrderMessage({
      type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
      order: CONFIRMED_ORDER,
      from: CREDENTIALS.from,
      fromName: 'Evil\r\nBcc: x@y.z',
    });
    assert.doesNotMatch(message, /Bcc:/);
  });

  it('reads the from name from the environment with a safe fallback', () => {
    assert.equal(readFromName({}), FROM_NAME_DEFAULT);
    assert.equal(readFromName({ PAWSHOP_EMAIL_FROM_NAME: 'Pawlivora' }), 'Pawlivora');
    assert.equal(readFromName({ PAWSHOP_EMAIL_FROM_NAME: '  Shop Brand  ' }), 'Shop Brand');
    // A line break is refused, falling back to the default.
    assert.equal(readFromName({ PAWSHOP_EMAIL_FROM_NAME: 'x\r\ny' }), FROM_NAME_DEFAULT);
  });
});

describe('support email configuration', () => {
  it('defaults to the current support address', () => {
    assert.equal(readSupportEmail({}), SUPPORT_EMAIL_DEFAULT);
    assert.equal(SUPPORT_EMAIL_DEFAULT, '504533680@qq.com');
  });

  it('switches to a configured address without a code change', () => {
    assert.equal(readSupportEmail({ PAWSHOP_SUPPORT_EMAIL: 'support@pawlivora.com' }), 'support@pawlivora.com');
  });

  it('rejects a malformed address and falls back', () => {
    assert.equal(readSupportEmail({ PAWSHOP_SUPPORT_EMAIL: 'not-an-email' }), SUPPORT_EMAIL_DEFAULT);
    assert.equal(readSupportEmail({ PAWSHOP_SUPPORT_EMAIL: 'x\r\nBcc: y' }), SUPPORT_EMAIL_DEFAULT);
    assert.equal(readSupportEmail({}), SUPPORT_EMAIL_DEFAULT);
  });

  it('is used verbatim in every notification body', () => {
    const custom = 'support@pawlivora.com';
    const confirmed = decodeBase64Body(buildOrderMessage({ type: NOTIFICATION_TYPES.ORDER_CONFIRMED, order: CONFIRMED_ORDER, from: CREDENTIALS.from, supportEmail: custom }));
    const shipped = decodeBase64Body(buildOrderMessage({ type: NOTIFICATION_TYPES.ORDER_SHIPPED, order: SHIPPED_ORDER, from: CREDENTIALS.from, supportEmail: custom }));
    const delivered = decodeBase64Body(buildOrderMessage({ type: NOTIFICATION_TYPES.ORDER_DELIVERED, order: DELIVERED_ORDER, from: CREDENTIALS.from, supportEmail: custom }));
    assert.match(confirmed, /contact us at support@pawlivora\.com/);
    assert.match(shipped, /contact us at support@pawlivora\.com/);
    assert.match(delivered, /contact us at support@pawlivora\.com/);
  });
});

describe('no_notification respect', () => {
  it('sends when no_notification is absent or false', () => {
    assert.equal(shouldSendNotification(undefined), true);
    assert.equal(shouldSendNotification(false), true);
  });

  it('suppresses when no_notification is true', () => {
    assert.equal(shouldSendNotification(true), false);
  });
});

describe('unique-violation detection', () => {
  it('recognises the Postgres 23505 code', () => {
    assert.equal(isUniqueViolation({ code: '23505' }), true);
  });

  it('recognises the duplicate-key message text', () => {
    assert.equal(isUniqueViolation({ message: 'duplicate key value violates unique constraint "IDX_transactional_email_sent_key_unique"' }), true);
  });

  it('walks a wrapped cause chain', () => {
    const wrapped = { cause: { cause: { code: '23505' } } };
    assert.equal(isUniqueViolation(wrapped), true);
  });

  it('returns false for an unrelated error', () => {
    assert.equal(isUniqueViolation({ code: '22000' }), false);
    assert.equal(isUniqueViolation(new Error('something else')), false);
  });
});

describe('send-state machine: lease expiry', () => {
  it('treats a null or past lease as expired', () => {
    assert.equal(isLeaseExpired(null, '2026-10-01T00:00:00Z'), true);
    assert.equal(isLeaseExpired('2026-10-01T00:00:00Z', '2026-10-01T00:00:01Z'), true);
  });

  it('treats a future lease as live', () => {
    assert.equal(isLeaseExpired('2026-10-01T00:05:00Z', '2026-10-01T00:00:00Z'), false);
  });
});

describe('send-state machine: claim decision', () => {
  const now = '2026-10-01T00:00:00Z';

  it('claims a brand-new event (no row)', () => {
    assert.equal(decideClaim(null, null, now), 'claim');
  });

  it('skips an event already in the terminal sent state', () => {
    assert.equal(decideClaim(SEND_STATES.SENT, null, now), 'skip_sent');
  });

  it('skips an event in the permanent terminal state', () => {
    assert.equal(decideClaim(SEND_STATES.TERMINAL, null, now), 'skip_terminal');
  });

  it('reports in-flight when another worker holds a live lease', () => {
    assert.equal(decideClaim(SEND_STATES.SENDING, '2026-10-01T00:05:00Z', now), 'in_flight');
  });

  it('claims a failed row (retry after SMTP failure)', () => {
    assert.equal(decideClaim(SEND_STATES.FAILED, null, now), 'claim');
  });

  it('claims a pending row', () => {
    assert.equal(decideClaim(SEND_STATES.PENDING, null, now), 'claim');
  });

  it('claims a stale sending row (crash recovery)', () => {
    assert.equal(decideClaim(SEND_STATES.SENDING, '2026-09-30T23:00:00Z', now), 'claim');
  });
});

describe('send-state machine: retryability', () => {
  it('treats connect and transport failures as retryable', () => {
    assert.equal(isRetryable('connect', new SmtpError('x', { code: 'ECONNREFUSED', stage: 'connect' })), true);
    assert.equal(isRetryable('transport', new SmtpError('x', { stage: 'transport' })), true);
  });

  it('treats a 4xx recipient refusal as retryable (transient)', () => {
    assert.equal(isRetryable('recipient', new SmtpError('x', { code: '450', stage: 'RCPT TO' })), true);
    assert.equal(isRetryable('recipient', new SmtpError('x', { code: '451', stage: 'RCPT TO' })), true);
  });

  it('treats a 5xx recipient refusal as permanent', () => {
    assert.equal(isRetryable('recipient', new SmtpError('x', { code: '550', stage: 'RCPT TO' })), false);
    assert.equal(isRetryable('recipient', new SmtpError('x', { code: '551', stage: 'RCPT TO' })), false);
  });

  it('treats auth, config and unknown as permanent', () => {
    assert.equal(isRetryable('auth', new SmtpError('x', { code: '535', stage: 'credentials' })), false);
    assert.equal(isRetryable('config', new SmtpError('x', { stage: 'config' })), false);
    assert.equal(isRetryable('missing_order', null), false);
    assert.equal(isRetryable('credentials', null), false);
    assert.equal(isRetryable('unknown', new Error('boom')), false);
  });
});

describe('send-state machine: retry backoff', () => {
  const now = '2026-10-01T00:00:00Z';

  it('exposes the agreed 1m/5m/15m/60m schedule (4 retry slots, no 5th)', () => {
    assert.deepEqual(BACKOFF_MS, [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000]);
  });

  it('schedules the first retry one minute out', () => {
    assert.equal(computeNextAttemptAt(1, now), '2026-10-01T00:01:00.000Z');
  });

  it('grows the backoff with each attempt', () => {
    assert.equal(computeNextAttemptAt(2, now), '2026-10-01T00:05:00.000Z');
    assert.equal(computeNextAttemptAt(3, now), '2026-10-01T00:15:00.000Z');
    assert.equal(computeNextAttemptAt(4, now), '2026-10-01T01:00:00.000Z');
  });

  it('never schedules a retry on the 5th (terminal) attempt', () => {
    // The 5th failed send must go terminal, not schedule a 6th send at 180m.
    assert.equal(computeNextAttemptAt(5, now), null);
    assert.equal(computeNextAttemptAt(6, now), null);
  });

  it('caps the max attempts at 5', () => {
    assert.equal(MAX_ATTEMPTS, 5);
  });
});

describe('send-state machine: SMTP error classification', () => {
  it('classifies an auth failure without leaking the relay text', () => {
    assert.equal(classifySmtpError(new SmtpError('The mail server refused the credentials step.', { code: '535', stage: 'credentials' })), 'auth');
  });

  it('classifies a connection failure', () => {
    assert.equal(classifySmtpError(new SmtpError('Could not reach the mail server.', { code: 'ECONNREFUSED', stage: 'connect' })), 'connect');
  });

  it('classifies a recipient refusal', () => {
    assert.equal(classifySmtpError(new SmtpError('refused', { code: '550', stage: 'RCPT TO' })), 'recipient');
  });

  it('classifies a 4xx transient refusal as recipient (retryable)', () => {
    assert.equal(classifySmtpError(new SmtpError('try later', { code: '450', stage: 'RCPT TO' })), 'recipient');
    assert.equal(classifySmtpError(new SmtpError('try later', { code: '452', stage: 'RCPT TO' })), 'recipient');
  });

  it('classifies a transport drop', () => {
    assert.equal(classifySmtpError(new SmtpError('closed', { stage: 'transport' })), 'transport');
  });

  it('classifies a local config error', () => {
    assert.equal(classifySmtpError(new SmtpError('bad host', { stage: 'config' })), 'config');
  });

  it('classifies a non-SMTP error as unknown', () => {
    assert.equal(classifySmtpError(new Error('boom')), 'unknown');
  });
});
