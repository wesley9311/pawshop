'use strict';

// The password-reset email channel.
//
// Medusa emits `auth.password_reset` and stops there: the framework ships no
// subscriber that delivers the token, and the notification module's default
// provider only writes to the log. Without this module the admin answers 201 to
// "forgot password" while the owner receives nothing - a silent failure of
// exactly the kind that kept the Feishu alert channel mute while monitoring
// reported healthy.
//
// So this module is deliberately explicit about the three outcomes that matter:
// the message was handed to a relay, no relay is configured, or a relay refused
// it. "Not configured" is reported as such and never as success.

const { lstatSync, openSync, closeSync, readFileSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { constants } = require('node:fs');
const { SmtpError, buildMessage, sendMessage } = require('./smtp-client.cjs');

const EMAIL_CREDENTIALS_PATH = '/etc/pawshop/email-credentials.json';
const MAX_CREDENTIALS_BYTES = 4096;
const RESET_TOKEN_TTL_MINUTES = 15;
const CREDENTIAL_FIELDS = ['from', 'host', 'password', 'port', 'secure', 'user'];

// `serviceGid` is the commerce service's group: the file may be root-only, or
// root-owned and group-readable by that one group. `ownerUid` exists so the test
// harness can assert the same rules against a file it owns; production always
// leaves it at root.
/**
 * @param {string} [path]
 * @param {{ serviceGid?: number | null, ownerUid?: number }} [options]
 * @returns {{ host: string, port: number, secure: boolean, user: string, password: string, from: string } | null}
 */
function readEmailCredentials(path = EMAIL_CREDENTIALS_PATH, { serviceGid = null, ownerUid = 0 } = {}) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  // The file holds a mail-relay credential: it must be owned by root, not a
  // symlink, and unreadable by anyone but root and the commerce service group.
  const permittedGids = serviceGid === null ? [0] : [0, serviceGid];
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== ownerUid || !permittedGids.includes(stat.gid) ||
      ![0o600, 0o640].includes(stat.mode & 0o777) || stat.size <= 0 || stat.size > MAX_CREDENTIALS_BYTES) {
    throw new Error('The email credentials file has unsafe ownership, type, permissions, or size.');
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed;
  try { parsed = JSON.parse(readFileSync(descriptor, 'utf8')); } finally { closeSync(descriptor); }
  return validateEmailCredentials(parsed);
}

function validateEmailCredentials(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join('\0') !== CREDENTIAL_FIELDS.join('\0')) {
    throw new Error('The email credentials do not match the approved contract.');
  }
  const { host, port, secure, user, password, from } = parsed;
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(host || '') ||
      !Number.isInteger(port) || port <= 0 || port > 65535 || typeof secure !== 'boolean' ||
      typeof user !== 'string' || user.length === 0 || user.length > 320 || /[\s\r\n]/.test(user) ||
      typeof password !== 'string' || password.length < 8 || password.length > 256 || /[\r\n]/.test(password) ||
      !/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/.test(from || '')) {
    throw new Error('The email credentials contain an invalid field.');
  }
  // A credential on port 25 or 587 without TLS would be sent in the clear.
  if (secure !== true && port !== 587) {
    throw new Error('The email channel requires implicit TLS or STARTTLS on port 587.');
  }
  return { host, port, secure, user, password, from };
}

function buildPasswordResetMessage({ from, to, resetUrl, ttlMinutes = RESET_TOKEN_TTL_MINUTES, now = new Date(), messageId }) {
  // The admin dashboard listens on loopback only and is reached through an SSH
  // tunnel. A recipient who opens the link without that tunnel sees a connection
  // error and reasonably concludes the link is broken, so the message says what
  // to do first instead of letting them diagnose it.
  const loopback = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(
    (() => { try { return new URL(resetUrl).origin; } catch { return ''; } })(),
  );
  const body = [
    'PawShop 后台管理密码重置',
    '',
    '有人为这个邮箱申请了 PawShop 后台管理密码重置。',
    `请在 ${ttlMinutes} 分钟内打开下面的链接设置新密码：`,
    '',
    resetUrl,
    '',
    ...(loopback ? [
      '注意：后台只监听服务器本机，请先建立 SSH 隧道（运维手册里有命令），',
      '再在浏览器里打开上面的链接——直接点会显示连接不上，那不是链接失效。',
      '',
    ] : []),
    '链接只能使用一次；过期后重新申请一次即可。',
    '这个链接等同于一次登录凭证，请勿转发给任何人。如果不是你本人操作，',
    '可以忽略这封邮件，你的密码不会发生任何变化。',
    '',
  ].join('\n');
  return buildMessage({
    from,
    to,
    subject: 'PawShop 后台密码重置',
    body,
    messageId: messageId || `<${randomBytes(16).toString('hex')}@pawlivora.com>`,
    date: now.toUTCString(),
  });
}

// The admin dashboard ships a reset page at /app/reset-password that reads the
// token from the query string. The token is a JWT the auth module already issued,
// so the link carries no secret this module invents.
function buildPasswordResetUrl({ adminOrigin, token }) {
  const origin = String(adminOrigin || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/.test(origin)) throw new Error('The admin origin for a reset link is invalid.');
  return `${origin}/app/reset-password?token=${encodeURIComponent(token)}`;
}

// Returns the recipient and link for an event this deployment can actually serve,
// or a reason why it cannot. Only admin users are served today: the public
// storefront is a static site with no reset page, so emailing a customer a link
// that leads nowhere would be worse than staying silent.
function passwordResetRecipient({ event, adminOrigin }) {
  const data = event?.data || {};
  if (data.actor_type !== 'user') {
    return { supported: false, reason: `actor type '${String(data.actor_type)}' has no reset page` };
  }
  const email = String(data.entity_id || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\.[a-z]{2,24}$/.test(email)) {
    return { supported: false, reason: 'the event carries no usable address' };
  }
  if (typeof data.token !== 'string' || data.token.length < 32 || /[\s\r\n]/.test(data.token)) {
    return { supported: false, reason: 'the event carries no usable reset token' };
  }
  return { supported: true, to: email, resetUrl: buildPasswordResetUrl({ adminOrigin, token: data.token }) };
}

// `sendOptions` carries the extra trust anchor the test harness needs; production
// never sets it, so the system trust store is what validates the relay there.
async function deliverPasswordReset({ recipient, credentials, now = new Date(), send = sendMessage, sendOptions = {} }) {
  if (!recipient?.supported) return { delivered: false, reason: recipient?.reason || 'unsupported recipient' };
  if (!credentials) return { delivered: false, reason: 'no email relay is configured' };
  const message = buildPasswordResetMessage({ from: credentials.from, to: recipient.to, resetUrl: recipient.resetUrl, now });
  try {
    await send({
      host: credentials.host, port: credentials.port, secure: credentials.secure,
      user: credentials.user, password: credentials.password,
      from: credentials.from, to: recipient.to, message,
      ...sendOptions,
    });
  } catch (error) {
    // The relay's own words are kept: a rejected credential and a rejected
    // recipient need different fixes, and a bare "failed" hides which one it was.
    const code = error instanceof SmtpError && error.code ? ` (code ${error.code}, stage ${error.stage})` : '';
    return { delivered: false, reason: `${error.message}${code}` };
  }
  return { delivered: true, to: recipient.to };
}

module.exports = {
  CREDENTIAL_FIELDS,
  EMAIL_CREDENTIALS_PATH,
  RESET_TOKEN_TTL_MINUTES,
  buildPasswordResetMessage,
  buildPasswordResetUrl,
  deliverPasswordReset,
  passwordResetRecipient,
  readEmailCredentials,
  validateEmailCredentials,
};
