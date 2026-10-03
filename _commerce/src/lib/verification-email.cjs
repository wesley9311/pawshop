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

const CODE_TTL_MINUTES = 15; // must match the token provider's default TTL (900s)

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render the verification email. Returns `null` when the recipient is not a
// plausible email address (so the caller can skip without sending).
function buildVerificationEmail({ to, code, from, fromName = 'Pawlivora', now = new Date() }) {
  if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(to.trim())) {
    return null;
  }
  const safeCode = String(code || '').replace(/[^0-9]/g, '');
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
async function deliverVerificationEmail({ to, code, credentials, fromName = 'Pawlivora', send = sendMessage }) {
  if (!credentials) return { sent: false, reason: 'no email relay is configured' };
  const message = buildVerificationEmail({ to, code, from: credentials.from, fromName });
  if (!message) return { sent: false, reason: 'invalid recipient address' };
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
  buildVerificationEmail,
  deliverVerificationEmail,
  readEmailCredentials,
};
