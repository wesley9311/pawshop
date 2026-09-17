'use strict';

// A deliberately small SMTP client.
//
// The commerce runtime needs to deliver exactly one kind of message - a password
// reset link - and nothing else. Medusa ships no email transport of its own, and
// the notification module's default provider writes to the log instead of sending,
// so "forgot password" would answer 201 and deliver nothing. Rather than add a
// dependency (and a supply-chain surface) for one message type, this speaks the
// small part of RFC 5321 that a submission relay needs: EHLO, AUTH LOGIN,
// MAIL FROM, RCPT TO, DATA, QUIT.
//
// It is intentionally not a general-purpose mailer: no pipelining, no DSN, no
// multiple recipients, no attachments. Every unsupported feature is refused
// loudly rather than silently ignored.

const net = require('node:net');
const tls = require('node:tls');

const DEFAULT_TIMEOUT_MS = 20000;
// A submission relay may greet slowly, but it may not hang the process. One
// deadline covers the whole session: connect, TLS, authentication, and the
// message body. A reset request must fail visibly instead of holding the HTTP
// request open until the client gives up.
const MAX_RESPONSE_BYTES = 8 * 1024;

class SmtpError extends Error {
  constructor(message, { code = '', stage = '' } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.stage = stage;
  }
}

// SMTP replies are one or more lines. A line whose fourth character is "-"
// announces more lines; the reply ends at a line whose fourth character is a
// space. Reading only the first line truncates multi-line replies such as EHLO's
// capability list and AUTH's continuation prompts.
function describeReply(raw) {
  const lines = raw.split('\r\n').filter((line) => line.length > 0);
  const last = lines[lines.length - 1] || '';
  const match = /^(\d{3})([ -])(.*)$/.exec(last);
  if (!match) throw new SmtpError('The mail server sent a reply that is not valid SMTP.', { stage: 'reply' });
  // Only the numeric code is surfaced. A relay's rejection text can echo the
  // recipient address and, on authentication failure, hints about the account.
  return { code: match[1], text: match[3] };
}

function createReader(socket) {
  let buffer = '';
  let settled = false;
  let pending = null;

  const deliver = () => {
    if (!pending) return;
    // A complete reply ends with CRLF and is not a continuation line.
    const lastBreak = buffer.lastIndexOf('\r\n');
    if (lastBreak < 0) return;
    const complete = buffer.slice(0, lastBreak + 2);
    const lines = complete.split('\r\n').filter((line) => line.length > 0);
    if (lines.length === 0) return;
    if (!/^\d{3} /.test(lines[lines.length - 1])) return;
    buffer = buffer.slice(lastBreak + 2);
    const waiting = pending;
    pending = null;
    waiting.resolve(complete);
  };

  const fail = (error) => {
    if (settled) return;
    settled = true;
    const waiting = pending;
    pending = null;
    if (waiting) waiting.reject(error);
  };

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > MAX_RESPONSE_BYTES) {
      fail(new SmtpError('The mail server reply exceeded the accepted size.', { stage: 'reply' }));
      return;
    }
    deliver();
  });
  socket.on('error', (error) => fail(new SmtpError(`The mail server connection failed: ${error.code || 'unknown'}.`, { stage: 'transport' })));
  socket.on('close', () => fail(new SmtpError('The mail server closed the connection before replying.', { stage: 'transport' })));

  return {
    read() {
      if (settled) return Promise.reject(new SmtpError('The mail server connection is no longer usable.', { stage: 'transport' }));
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        deliver();
      });
    },
    stop() {
      settled = true;
      pending = null;
    },
  };
}

function writeCommand(socket, command) {
  // A bare CR or LF inside a command would let a crafted value inject an extra
  // SMTP verb. Addresses and credentials arrive from configuration, but the
  // recipient of a reset message comes from the request path, so this is enforced
  // rather than assumed.
  if (/[\r\n]/.test(command)) throw new SmtpError('An SMTP command may not contain a line break.', { stage: 'command' });
  socket.write(`${command}\r\n`);
}

async function expect(reader, stage, acceptedCodes) {
  const raw = await reader.read();
  const { code, text } = describeReply(raw);
  if (!acceptedCodes.includes(code)) {
    throw new SmtpError(`The mail server refused the ${stage} step.`, { code, stage });
  }
  return text;
}

// The relay's name is handed to TLS as `host`, not as `servername`. Node derives
// SNI from it when it is a name and validates the certificate against it either
// way, and it omits SNI by itself for an IP address, which RFC 6066 forbids there.
function connect({ host, port, secure, timeoutMs, ca }) {
  return new Promise((resolve, reject) => {
    const options = { host, port };
    const socket = secure
      ? tls.connect({ ...options, rejectUnauthorized: true, ...(ca ? { ca } : {}) })
      : net.connect(options);
    const onFailure = (error) => {
      socket.destroy();
      reject(new SmtpError(`Could not reach the mail server: ${error.code || 'unknown'}.`, { stage: 'connect' }));
    };
    socket.setTimeout(timeoutMs, () => onFailure({ code: 'ETIMEDOUT' }));
    socket.once('error', onFailure);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', onFailure);
      resolve(socket);
    });
  });
}

function upgradeToTls(socket, { host, timeoutMs, ca }) {
  return new Promise((resolve, reject) => {
    // The socket is already connected, so `host` is not re-resolved here: it tells
    // TLS which name to validate the relay's certificate against.
    const secured = tls.connect({ socket, host, rejectUnauthorized: true, ...(ca ? { ca } : {}) });
    const onFailure = (error) => {
      secured.destroy();
      reject(new SmtpError(`Could not start TLS with the mail server: ${error.code || 'unknown'}.`, { stage: 'starttls' }));
    };
    secured.setTimeout(timeoutMs, () => onFailure({ code: 'ETIMEDOUT' }));
    secured.once('error', onFailure);
    secured.once('secureConnect', () => {
      secured.removeListener('error', onFailure);
      resolve(secured);
    });
  });
}

// SMTP authentication sends the username and password as base64. That is
// transport encoding, not protection: it is only acceptable inside TLS, which is
// why this client refuses to authenticate on a plaintext connection.
async function authenticate(socket, reader, { user, password }) {
  await expect(reader, 'AUTH', ['334']);
  writeCommand(socket, Buffer.from(user, 'utf8').toString('base64'));
  await expect(reader, 'username', ['334']);
  writeCommand(socket, Buffer.from(password, 'utf8').toString('base64'));
  await expect(reader, 'credentials', ['235']);
}

// A message body is terminated by a line containing a single dot, so any body
// line that starts with a dot must be doubled to survive the transfer intact.
function dotStuff(body) {
  return body.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
}

// Body and subject are encoded rather than sent raw: a relay is free to rewrite
// or drop bare non-ASCII bytes, and a reset link that changes by one character is
// a reset link that does not work.
function encodeHeaderValue(value) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function foldBase64(encoded) {
  return encoded.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '');
}

function buildMessage({ from, to, subject, body, messageId, date }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    foldBase64(Buffer.from(body, 'utf8').toString('base64')),
  ];
  return lines.join('\r\n');
}

// `secure` selects implicit TLS (submission over 465). A relay that offers only
// STARTTLS on 587 is upgraded before any credential is written to the socket.
// `ca` exists so the test harness can trust the certificate it generated; it is
// never set in production, where the system trust store applies.
async function sendMessage({ host, port, secure, user, password, from, to, message, timeoutMs = DEFAULT_TIMEOUT_MS, ca }) {
  for (const [label, value] of [['host', host], ['user', user], ['password', password], ['from', from], ['to', to]]) {
    if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
      throw new SmtpError(`The mail ${label} is missing or invalid.`, { stage: 'config' });
    }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SmtpError('The mail port is invalid.', { stage: 'config' });
  }

  let socket = await connect({ host, port, secure: secure === true, timeoutMs, ca });
  let reader = createReader(socket);
  try {
    await expect(reader, 'greeting', ['220']);
    writeCommand(socket, 'EHLO pawlivora.com');
    await expect(reader, 'EHLO', ['250']);

    if (secure !== true) {
      writeCommand(socket, 'STARTTLS');
      await expect(reader, 'STARTTLS', ['220']);
      reader.stop();
      socket = await upgradeToTls(socket, { host, timeoutMs, ca });
      reader = createReader(socket);
      writeCommand(socket, 'EHLO pawlivora.com');
      await expect(reader, 'EHLO after STARTTLS', ['250']);
    }

    writeCommand(socket, 'AUTH LOGIN');
    await authenticate(socket, reader, { user, password });

    writeCommand(socket, `MAIL FROM:<${from}>`);
    await expect(reader, 'MAIL FROM', ['250']);
    writeCommand(socket, `RCPT TO:<${to}>`);
    await expect(reader, 'RCPT TO', ['250', '251']);
    writeCommand(socket, 'DATA');
    await expect(reader, 'DATA', ['354']);
    socket.write(`${dotStuff(message)}\r\n.\r\n`);
    await expect(reader, 'message body', ['250']);

    writeCommand(socket, 'QUIT');
    // A relay that accepts the message but stalls on QUIT has still delivered it,
    // so the acknowledgement already received is the result and QUIT is courtesy.
    await Promise.race([
      reader.read().catch(() => null),
      new Promise((resolve) => socket.once('close', resolve)),
    ]);
    return { delivered: true };
  } finally {
    reader.stop();
    socket.destroy();
  }
}

module.exports = { SmtpError, buildMessage, describeReply, dotStuff, encodeHeaderValue, sendMessage };
