'use strict';

// Customer email-verification code delivery.
//
// Medusa's auth module generates a verification code and emits
// `auth.verification_requested`, but ships no subscriber that delivers it — the
// built-in `token` provider stores only a hash. This module turns that event into
// a real email through the same SMTP relay the transactional emails use, so a
// customer registering gets their code.
//
// Security / privacy invariants:
//   - the code is rendered into the email body only; it is never logged, never
//     persisted to a table, and never echoed back in any API response.
//   - the "from" and "to" are validated; a malformed recipient is a no-op, not an
//     error that leaks anything.

const { SmtpError, buildMessage, sendMessage } = require('./smtp-client.cjs');
const { readEmailCredentials } = require('./email-channel.cjs');
const { writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const CODE_TTL_MINUTES = 15; // must match the token provider's default TTL (900s)

// Test-only capture directory. When set, the verification code is written to a
// file under this directory instead of being handed to the SMTP relay. This is
// the loopback acceptance transport: the subscriber still renders the code and
// hands it to a transport, and the harness reads the real code back to drive a
// REAL `confirm` (never a `UPDATE auth_verification SET verified_at`).
//
// The real production `commerce.env` (the 20-key contract) does NOT contain this
// variable, and nothing in production sets it — codes are real customer secrets
// that leave the process only through the SMTP relay. It is set exclusively by
// the isolated loopback acceptance environment (diag.env) to capture the code the
// harness must read back. The subscriber logs "captured" (not "delivered") when
// this path runs, so an accidental misconfiguration is immediately visible.
const CAPTURE_DIR_ENV = 'PAWSHOP_VERIFICATION_EMAIL_CAPTURE';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render the verification email. Returns `null` when the recipient is not a
// plausible email address OR the code is not a well-formed 6-digit numeric OTP
// (so the caller can skip without sending).
//
// The code is expected to be exactly six decimal digits. We deliberately do NOT
// strip non-digits from an arbitrary token: that is the bug that produced a
// "pseudo-code" from the 43-character base64url token and made confirmation
// impossible. Any code that is not already 6 digits is refused, never mangled.
function buildVerificationEmail({ to, code, from, fromName = 'Pawlivora', now = new Date() }) {
  if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(to.trim())) {
    return null;
  }
  const safeCode = String(code == null ? '' : code).trim();
  if (!/^[0-9]{6}$/.test(safeCode)) {
    return null;
  }
  const body = [
    'Your PawShop verification code',
    '',
    `Your verification code is ${safeCode}.`,
    `It expires in ${CODE_TTL_MINUTES} minutes.`,
    '',
    'If you did not request this code, you can safely ignore this email.',
  ].join('\r\n');

  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#0f172a">',
    '  <h1 style="font-size:18px">Your PawShop verification code</h1>',
    `  <p style="font-size:26px;letter-spacing:4px;font-weight:700">${escapeHtml(safeCode)}</p>`,
    `  <p style="color:#64748b">This code expires in ${CODE_TTL_MINUTES} minutes.</p>`,
    '  <p style="color:#94a3b8">If you did not request this code, you can safely ignore this email.</p>',
    '</div>',
  ].join('');

  return buildMessage({
    from,
    to: to.trim(),
    subject: 'Your PawShop verification code',
    body,
    html,
    messageId: `<${Date.now().toString(16)}.verification@pawlivora.com>`,
    date: now.toUTCString(),
  });
}

// Deliver a verification code. Returns a structured outcome so the subscriber can
// log "sent" / "no relay" / "refused" without ever claiming delivery that did not
// happen. `send` is injectable for tests.
//
// When `process.env[CAPTURE_DIR_ENV]` is set, the code is captured to a file under
// that directory instead of sent over SMTP. This is the loopback acceptance
// transport: it exercises the real render→deliver path (the same one the P0 bug
// corrupted) while giving the harness the actual 6-digit code to submit to
// `confirm`. The code file is written with the same discipline as SMTP delivery —
// only the code and recipient, never a log line.
async function deliverVerificationEmail({ to, code, credentials, fromName = 'Pawlivora', send = sendMessage }) {
  const captureDir = typeof process.env[CAPTURE_DIR_ENV] === 'string' ? process.env[CAPTURE_DIR_ENV].trim() : '';
  if (captureDir) {
    const message = buildVerificationEmail({ to, code, from: 'capture@loopback.test', fromName });
    if (!message) return { sent: false, reason: 'invalid recipient address or malformed code' };
    try {
      mkdirSync(captureDir, { recursive: true });
      const file = path.join(captureDir, `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.code`);
      // The code is a 6-digit string already validated by buildVerificationEmail.
      writeFileSync(file, `${to.trim()}\n${String(code).trim()}\n`, { encoding: 'utf8', mode: 0o600 });
      return { sent: true, to: to.trim(), capturedTo: file };
    } catch (error) {
      return { sent: false, reason: `capture failed: ${error.message}` };
    }
  }
  if (!credentials) return { sent: false, reason: 'no email relay is configured' };
  const message = buildVerificationEmail({ to, code, from: credentials.from, fromName });
  if (!message) return { sent: false, reason: 'invalid recipient address or malformed code' };
  try {
    await send({
      host: credentials.host,
      port: credentials.port,
      secure: credentials.secure,
      user: credentials.user,
      password: credentials.password,
      from: credentials.from,
      to: to.trim(),
      message,
    });
  } catch (error) {
    const code = error instanceof SmtpError && error.code ? ` (code ${error.code}, stage ${error.stage})` : '';
    return { sent: false, reason: `${error.message}${code}`, error };
  }
  return { sent: true, to: to.trim() };
}

module.exports = {
  CODE_TTL_MINUTES,
  CAPTURE_DIR_ENV,
  buildVerificationEmail,
  deliverVerificationEmail,
  readEmailCredentials,
};
