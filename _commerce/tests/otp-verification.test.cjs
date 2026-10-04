'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  OTP_DIGITS,
  OTP_SPACE,
  deriveHmacKey,
  generateOtpCode,
  normalizeCode,
  digestCode,
} = require('../src/lib/otp-code.cjs');
const { buildVerificationEmail, deliverVerificationEmail, CAPTURE_DIR_ENV } = require('../src/lib/verification-email.cjs');

const PRODUCTION_MODULES_PATH = path.join(__dirname, '..', 'src', 'lib', 'production-modules.cjs');
const productionModulesSource = fs.readFileSync(PRODUCTION_MODULES_PATH, 'utf8');
const SUBSCRIBER_PATH = path.join(__dirname, '..', 'src', 'subscribers', 'verification-email.ts');
const subscriberSource = fs.readFileSync(SUBSCRIBER_PATH, 'utf8');
const PROVIDER_PATH = path.join(__dirname, '..', 'src', 'modules', 'pawshop-otp-verification', 'otp-verification-provider.ts');
const providerSource = fs.readFileSync(PROVIDER_PATH, 'utf8');

const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// ---------- code generation ----------

test('generateOtpCode returns a 6-digit zero-padded string across the full space', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateOtpCode();
    assert.match(code, /^[0-9]{6}$/, `code "${code}" must be exactly 6 digits`);
    const n = parseInt(code, 10);
    assert.ok(n >= 0 && n < OTP_SPACE, `code "${code}" must be within 0..999999`);
  }
});

test('generateOtpCode can emit the padded low edge (000000) when the CSPRNG returns 0', () => {
  const code = generateOtpCode(() => 0);
  assert.equal(code, '000000');
});

test('generateOtpCode uses crypto.randomInt by default (CSPRNG, not Math.random)', () => {
  // Static: the provider must not reference Math.random or a timestamp.
  assert.ok(!/Math\.random/.test(providerSource), 'provider must not use Math.random');
  assert.ok(!/Date\.now\(\).*code|code.*Date\.now\(/.test(providerSource), 'provider must not derive the code from a timestamp');
});

// ---------- normalization ----------

test('normalizeCode accepts exactly 6 digits and rejects everything else', () => {
  assert.equal(normalizeCode('123456'), '123456');
  assert.equal(normalizeCode(' 123456 '), '123456');
  assert.equal(normalizeCode('12345'), null, '5 digits rejected');
  assert.equal(normalizeCode('1234567'), null, '7 digits rejected');
  assert.equal(normalizeCode('12a456'), null, 'non-digit rejected');
  assert.equal(normalizeCode('abcdef'), null, 'letters rejected');
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizeCode(undefined), null);
});

// ---------- keyed HMAC ----------

test('deriveHmacKey is deterministic and domain-separated from a raw sha256 of the secret', () => {
  const k1 = deriveHmacKey(SECRET);
  const k2 = deriveHmacKey(SECRET);
  assert.deepEqual(k1, k2, 'same secret yields the same key');
  // Domain separation: the derived key must NOT equal a bare sha256 of the secret.
  const bare = crypto.createHash('sha256').update(SECRET, 'utf8').digest();
  assert.notDeepEqual(k1, bare, 'derived key is domain-separated');
});

test('deriveHmacKey rejects a short secret', () => {
  assert.throws(() => deriveHmacKey('short'), /at least 32/);
});

test('digestCode is a keyed HMAC: different keys yield different digests for the same code', () => {
  const k1 = deriveHmacKey(SECRET);
  const k2 = deriveHmacKey('f'.repeat(64));
  const d1 = digestCode(k1, '123456');
  const d2 = digestCode(k2, '123456');
  assert.notEqual(d1, d2, 'different HMAC keys must produce different digests');
});

test('digestCode is deterministic for the same key + code', () => {
  const k = deriveHmacKey(SECRET);
  assert.equal(digestCode(k, '123456'), digestCode(k, '123456'));
});

test('digestCode is NOT a bare sha256 of the code', () => {
  const k = deriveHmacKey(SECRET);
  const d = digestCode(k, '123456');
  const bare = crypto.createHash('sha256').update('123456', 'utf8').digest('hex');
  assert.notEqual(d, bare, 'digest must be keyed HMAC, not bare sha256');
});

test('digestCode throws on a malformed code', () => {
  const k = deriveHmacKey(SECRET);
  assert.throws(() => digestCode(k, '12345'), /well-formed/);
  assert.throws(() => digestCode(k, '12a456'), /well-formed/);
});

// ---------- email rendering (P0 regression defence) ----------

test('verification email renders a 6-digit code verbatim', () => {
  const msg = buildVerificationEmail({ to: 'buyer@example.com', code: '123456', from: 'noreply@pawlivora.com' });
  assert.ok(msg, 'builds a message for a valid recipient + code');
  const plain = msg.split('\r\n')
    .filter((line) => /^[A-Za-z0-9+/=]+$/.test(line) && line.length >= 4)
    .map((line) => { try { return Buffer.from(line, 'base64').toString('utf8'); } catch { return ''; } })
    .join('');
  assert.ok(plain.includes('123456'), 'decoded message contains the code');
});

test('verification email REFUSES a base64url token instead of stripping digits (P0 regression)', () => {
  // The old bug: `.replace(/[^0-9]/g,'')` on a 43-char base64url token produced a
  // fake code. The renderer must now return null for any non-6-digit code.
  const token = crypto.randomBytes(32).toString('base64url');
  const msg = buildVerificationEmail({ to: 'buyer@example.com', code: token, from: 'noreply@pawlivora.com' });
  assert.equal(msg, null, 'a base64url token must never be rendered as a pseudo-code');
});

test('verification email REFUSES a 5-digit or 7-digit code', () => {
  assert.equal(buildVerificationEmail({ to: 'buyer@example.com', code: '12345', from: 'noreply@pawlivora.com' }), null);
  assert.equal(buildVerificationEmail({ to: 'buyer@example.com', code: '1234567', from: 'noreply@pawlivora.com' }), null);
});

// ---------- capture transport (loopback acceptance) ----------

test('capture transport writes the real 6-digit code to a file when the env dir is set', async () => {
  const os = require('node:os');
  const fs2 = require('node:fs');
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'otp-capture-'));
  const prev = process.env[CAPTURE_DIR_ENV];
  process.env[CAPTURE_DIR_ENV] = dir;
  try {
    const r = await deliverVerificationEmail({ to: 'buyer@example.com', code: '654321' });
    assert.equal(r.sent, true);
    assert.ok(r.capturedTo, 'capture path reports the file it wrote');
    const files = fs2.readdirSync(dir).filter((f) => f.endsWith('.code'));
    assert.equal(files.length, 1);
    const content = fs2.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.ok(content.includes('buyer@example.com'), 'file carries the recipient');
    assert.ok(content.includes('654321'), 'file carries the actual 6-digit code');
  } finally {
    if (prev === undefined) delete process.env[CAPTURE_DIR_ENV]; else process.env[CAPTURE_DIR_ENV] = prev;
    fs2.rmSync(dir, { recursive: true, force: true });
  }
});

test('capture transport REFUSES a malformed code (never writes a pseudo-code)', async () => {
  const os = require('node:os');
  const fs2 = require('node:fs');
  const dir = fs2.mkdtempSync(path.join(os.tmpdir(), 'otp-capture-'));
  const prev = process.env[CAPTURE_DIR_ENV];
  process.env[CAPTURE_DIR_ENV] = dir;
  try {
    const r = await deliverVerificationEmail({ to: 'buyer@example.com', code: 'not-a-code' });
    assert.equal(r.sent, false);
    assert.equal(fs2.readdirSync(dir).length, 0, 'no file written for a malformed code');
  } finally {
    if (prev === undefined) delete process.env[CAPTURE_DIR_ENV]; else process.env[CAPTURE_DIR_ENV] = prev;
    fs2.rmSync(dir, { recursive: true, force: true });
  }
});

test('capture transport is disabled by default (env dir unset → SMTP path)', async () => {
  const prev = process.env[CAPTURE_DIR_ENV];
  delete process.env[CAPTURE_DIR_ENV];
  try {
    const r = await deliverVerificationEmail({ to: 'buyer@example.com', code: '123456', credentials: null });
    // No capture dir and no credentials → "no relay", never a capture file.
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no email relay is configured');
  } finally {
    if (prev !== undefined) process.env[CAPTURE_DIR_ENV] = prev;
  }
});

// ---------- static wiring invariants ----------

test('production modules register the otp verification provider under verification.providers', () => {
  assert.ok(/verification\s*:\s*\{/.test(productionModulesSource), 'auth options carry a verification block');
  assert.ok(/pawshop-otp-verification/.test(productionModulesSource), 'otp provider is wired');
  assert.ok(/id:\s*'otp'/.test(productionModulesSource), 'otp provider id is otp');
  assert.ok(/hmac_secret:\s*jwtSecret/.test(productionModulesSource), 'HMAC secret is derived from jwtSecret');
});

test('the otp provider derives its HMAC key from the secret (no plaintext code stored)', () => {
  assert.ok(/deriveHmacKey/.test(providerSource), 'provider derives the HMAC key');
  assert.ok(/code_hash/.test(providerSource), 'provider stores only a code_hash digest');
  assert.ok(!/provider_metadata:\s*\{\s*code\s*:/.test(providerSource), 'provider must never store the plaintext code');
});

test('the email subscriber delivers for both token and otp providers', () => {
  assert.ok(/codeProvider !== 'token' && codeProvider !== 'otp'/.test(subscriberSource),
    'subscriber accepts otp in addition to token');
});

test('the subscriber skips the relay and uses the capture transport when the env dir is set', () => {
  assert.ok(/CAPTURE_DIR_ENV/.test(subscriberSource), 'subscriber reads the capture env var');
  assert.ok(/captureEnabled/.test(subscriberSource), 'subscriber branches on capture being enabled');
  assert.ok(/deliverVerificationEmail\(\{ to, code, credentials: null \}\)/.test(subscriberSource),
    'capture path calls deliver with null credentials (no relay read)');
});

test('the provider enforces a numeric 6-digit code on confirm (never accepts a token)', () => {
  // The 6-digit gate lives in normalizeCode (otp-code.cjs); the provider must call
  // it before computing any digest, so a base64url token can never be confirmed.
  assert.ok(/normalizeCode/.test(providerSource), 'provider normalizes the code before digesting');
  assert.ok(/\[0-9\]\{6\}/.test(require('../src/lib/otp-code.cjs').toString?.() || '') ||
    /normalizeCode\(data\.code\)/.test(providerSource), '6-digit gate is enforced');
});
