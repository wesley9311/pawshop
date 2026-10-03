'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeEmail, isClaimableEmail, decideClaim } = require('../src/lib/customer-claim.cjs');
const {
  COOLDOWN_MS,
  EMAIL_PER_HOUR,
  IP_PER_HOUR,
  WINDOW_MS,
  evaluate,
} = require('../src/lib/verification-rate-limit.cjs');
const { buildVerificationEmail } = require('../src/lib/verification-email.cjs');

const ROUTE_PATH = path.join(__dirname, '..', 'src', 'api', 'store', 'customers', 'route.ts');
const routeSource = fs.readFileSync(ROUTE_PATH, 'utf8');
const MIGRATION_PATH = path.join(
  __dirname, '..', 'src', 'modules', 'pawshop-customer-auth', 'migrations', 'Migration20261004000000.ts',
);
const migrationSource = fs.readFileSync(MIGRATION_PATH, 'utf8');

// ---------- email normalization ----------

test('email normalization trims and lowercases', () => {
  assert.equal(normalizeEmail('  Buyer@Example.COM '), 'buyer@example.com');
  assert.equal(normalizeEmail(null), '');
  assert.equal(normalizeEmail(undefined), '');
});

test('claimable email rejects malformed input', () => {
  assert.equal(isClaimableEmail('buyer@example.com'), true);
  assert.equal(isClaimableEmail('not-an-email'), false);
  assert.equal(isClaimableEmail(''), false);
});

// ---------- claim decision ----------

test('decideClaim: no existing customer → create', () => {
  assert.deepEqual(decideClaim([]), { kind: 'create' });
});

test('decideClaim: exactly one guest customer → claim', () => {
  assert.deepEqual(
    decideClaim([{ id: 'cus_1', has_account: false }]),
    { kind: 'claim', customerId: 'cus_1' },
  );
});

test('decideClaim: exactly one account customer → already_claimed (idempotent)', () => {
  assert.deepEqual(
    decideClaim([{ id: 'cus_1', has_account: true }]),
    { kind: 'already_claimed', customerId: 'cus_1' },
  );
});

test('decideClaim: more than one customer → conflict (never auto-merge)', () => {
  assert.deepEqual(
    decideClaim([{ id: 'cus_1', has_account: false }, { id: 'cus_2', has_account: false }]),
    { kind: 'conflict', count: 2 },
  );
});

test('decideClaim: a guest + an account customer for the same email → conflict', () => {
  assert.equal(
    decideClaim([{ id: 'cus_1', has_account: false }, { id: 'cus_2', has_account: true }]).kind,
    'conflict',
  );
});

// ---------- verification rate limit ----------

function clockAt(ms) {
  return { now: () => ms };
}

test('evaluate allows the first request', () => {
  const r = evaluate([], { limit: 5, cooldownMs: COOLDOWN_MS, windowMs: WINDOW_MS });
  assert.equal(r.allowed, true);
});

test('evaluate enforces the 60s cooldown', () => {
  const t0 = 1_000_000_000_000;
  const history = [t0];
  history._clock = clockAt(t0 + 30_000); // 30s later
  const r = evaluate(history, { limit: 5, cooldownMs: COOLDOWN_MS, windowMs: WINDOW_MS });
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterMs > 0 && r.retryAfterMs <= 30_000);
});

test('evaluate allows a request after the cooldown has elapsed', () => {
  const t0 = 1_000_000_000_000;
  const history = [t0];
  history._clock = clockAt(t0 + 61_000); // 61s later
  const r = evaluate(history, { limit: 5, cooldownMs: COOLDOWN_MS, windowMs: WINDOW_MS });
  assert.equal(r.allowed, true);
});

test('evaluate enforces the per-hour cap', () => {
  const t0 = 1_000_000_000_000;
  const history = [t0, t0 + 60_000, t0 + 120_000, t0 + 180_000, t0 + 240_000];
  history._clock = clockAt(t0 + 300_000);
  const r = evaluate(history, { limit: 5, cooldownMs: 0, windowMs: WINDOW_MS });
  assert.equal(r.allowed, false);
});

// ---------- verification email ----------

test('verification email renders the code and never echoes a malformed recipient', () => {
  const msg = buildVerificationEmail({ to: 'buyer@example.com', code: '123456', from: 'noreply@pawlivora.com' });
  assert.ok(msg, 'builds a message for a valid recipient');
  // buildMessage base64-encodes the parts, so the code appears as the base64 of
  // the plain-text part that contains it. Decode every base64 run and assert the
  // code is present in the decoded plain text.
  const decoded = Buffer.from(msg, 'utf8').toString('utf8');
  const plain = msg.split('\r\n')
    .filter((line) => /^[A-Za-z0-9+/=]+$/.test(line) && line.length >= 4)
    .map((line) => { try { return Buffer.from(line, 'base64').toString('utf8'); } catch { return ''; } })
    .join('');
  assert.ok(plain.includes('123456'), 'decoded message contains the code');

  const bad = buildVerificationEmail({ to: 'not-an-email', code: '123456', from: 'noreply@pawlivora.com' });
  assert.equal(bad, null, 'returns null for a malformed recipient');
});

test('verification email never persists a code/token/password/body (no such columns)', () => {
  // The claim audit and rate tables must not store a code, token, password or body.
  assert.ok(!/code|token|password|body/i.test(migrationSource.match(/create table[\s\S]*?\);/g)[0] || ''),
    'claim audit migration has no sensitive columns');
});

// ---------- route security invariants (static) ----------

test('the registration route never reads a customer_id from the request body/query', () => {
  assert.ok(!/body\s*\.\s*customer_id|query\s*\.\s*customer_id|customer_id\s*[:=]\s*req/.test(routeSource),
    'route must not trust a client-supplied customer_id');
});

test('the registration route resolves identity from auth_context.auth_identity_id', () => {
  assert.ok(/auth_context/.test(routeSource), 'route reads auth_context');
  assert.ok(/auth_identity_id/.test(routeSource), 'route uses the auth_identity_id');
});

test('the migration is additive-only (create table / index, no alter/drop of commerce tables)', () => {
  assert.ok(/create table/.test(migrationSource), 'creates tables');
  assert.ok(!/alter table/i.test(migrationSource), 'no ALTER TABLE');
  assert.ok(!/drop table\s+"(order|product|customer|cart|payment|fulfillment)"/i.test(migrationSource),
    'never drops a commerce table');
});
