'use strict';

// Pure helpers for the 6-digit numeric OTP verification provider.
//
// Lifted out of the provider class so the code generation, key derivation, and
// digest are unit-testable without booting Medusa (the same pattern the claim
// decision and rate-limit helpers use). The provider keeps only the I/O: resolve
// `authVerificationService`, call request/confirm.
//
// Security invariants:
//   - `generateOtpCode` uses `crypto.randomInt` (CSPRNG) over the full
//     0..999999 space and zero-pads to exactly 6 digits. `Math.random`, a
//     timestamp, an email-derived value, or stripping digits from a token are all
//     forbidden (the latter was the bug that produced a non-confirmable code).
//   - `deriveHmacKey` domain-separates the OTP HMAC key from the JWT signing key
//     derived from the same secret, so the two keys can never collide.
//   - `digestCode` is a keyed HMAC-SHA256, NOT a bare sha256: a bare sha256 of a
//     6-digit code is enumerable (only 1,000,000 candidates).

const nodeCrypto = require('node:crypto');

const OTP_DIGITS = 6;
const OTP_SPACE = 10 ** OTP_DIGITS; // 1,000,000

// Fixed domain-separation label. Never user controlled.
const HMAC_DOMAIN = 'pawshop:otp-verification:v1';

// Derive the OTP HMAC key from the base secret (the validated JWT_SECRET).
function deriveHmacKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('deriveHmacKey requires a secret of at least 32 characters.');
  }
  return nodeCrypto
    .createHash('sha256')
    .update(HMAC_DOMAIN)
    .update('\0')
    .update(secret, 'utf8')
    .digest();
}

// Generate a uniformly random 6-digit code (000000–999999), zero-padded.
function generateOtpCode(randomInt = nodeCrypto.randomInt) {
  const n = randomInt(0, OTP_SPACE);
  return String(n).padStart(OTP_DIGITS, '0');
}

// Normalize a user-supplied code to exactly 6 digits, or return null when it is
// not a well-formed 6-digit numeric string. This is the gate that rejects
// wrong-length / non-numeric input before any digest is computed.
function normalizeCode(code) {
  const s = String(code == null ? '' : code).trim();
  return /^[0-9]{6}$/.test(s) ? s : null;
}

// Compute the keyed HMAC digest (hex) for a normalized 6-digit code.
function digestCode(hmacKey, code) {
  const normalized = normalizeCode(code);
  if (normalized === null) {
    throw new Error('digestCode requires a well-formed 6-digit numeric code.');
  }
  return nodeCrypto
    .createHmac('sha256', hmacKey)
    .update(normalized, 'utf8')
    .digest('hex');
}

module.exports = {
  OTP_DIGITS,
  OTP_SPACE,
  HMAC_DOMAIN,
  deriveHmacKey,
  generateOtpCode,
  normalizeCode,
  digestCode,
};
