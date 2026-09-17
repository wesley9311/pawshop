'use strict';

// The password-reset path had no coverage because it did not exist: Medusa emits
// `auth.password_reset` and ships no subscriber, so the admin answered 201 to
// "forgot password" while nothing was ever sent. These tests pin the behaviour
// that replaces it, including the outcome that matters most - a mail relay that
// is absent or refuses the message is reported as such and never as success.

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { describeReply, dotStuff, sendMessage } = require('../src/lib/smtp-client.cjs');
const {
  buildPasswordResetMessage, buildPasswordResetUrl, deliverPasswordReset,
  passwordResetRecipient, readEmailCredentials, validateEmailCredentials,
} = require('../src/lib/email-channel.cjs');

let startSmtpSink;
let certificate;
let workspace;

before(async () => {
  ({ startSmtpSink } = await import('./email-delivery/smtp-sink.mjs'));
  workspace = mkdtempSync(join(tmpdir(), 'pawshop-email-'));
  const keyPath = join(workspace, 'key.pem');
  const certPath = join(workspace, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  certificate = { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
});

after(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

const CREDENTIALS = {
  host: '127.0.0.1', port: 465, secure: true,
  user: 'owner@example.test', password: 'app-password-1234',
  from: 'owner@example.test',
};

function decodeBase64Body(message) {
  const [, payload = ''] = message.split('\r\n\r\n');
  return Buffer.from(payload.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('SMTP reply parsing', () => {
  it('reads the end of a multi-line reply rather than its first line', () => {
    // Taking the first line would classify EHLO's capability list by the wrong code.
    assert.deepEqual(describeReply('250-sink.test\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n'),
      { code: '250', text: '8BITMIME' });
    assert.deepEqual(describeReply('535 5.7.8 nope\r\n'), { code: '535', text: '5.7.8 nope' });
    assert.throws(() => describeReply('not smtp\r\n'), /not valid SMTP/);
  });
});

describe('message framing', () => {
  it('doubles a leading dot so the body survives the terminating dot', () => {
    assert.equal(dotStuff('.hidden\r\nplain'), '..hidden\r\nplain');
    assert.equal(dotStuff('first\r\n.second'), 'first\r\n..second');
  });

  it('encodes the subject and body rather than sending raw non-ASCII', () => {
    const message = buildPasswordResetMessage({
      from: 'owner@example.test', to: 'owner@example.test',
      resetUrl: 'http://127.0.0.1:9000/app/reset-password?token=abc',
      now: new Date('2026-09-17T07:44:00Z'), messageId: '<fixed@sink.test>',
    });
    assert.match(message, /^From: owner@example\.test$/m);
    assert.match(message, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(message, /^Content-Transfer-Encoding: base64$/m);
    assert.match(message, /^Auto-Submitted: auto-generated$/m);
    assert.ok(decodeBase64Body(message).includes('http://127.0.0.1:9000/app/reset-password?token=abc'));
  });
});

describe('email credentials', () => {
  it('refuses a relay that would send a credential in the clear', () => {
    assert.throws(() => validateEmailCredentials({ ...CREDENTIALS, secure: false, port: 25 }), /implicit TLS|STARTTLS/);
    assert.doesNotThrow(() => validateEmailCredentials({ ...CREDENTIALS, secure: false, port: 587 }));
  });

  it('refuses an incomplete or oversized credential set', () => {
    assert.throws(() => validateEmailCredentials({ ...CREDENTIALS, extra: 'x' }), /approved contract/);
    assert.throws(() => validateEmailCredentials({ ...CREDENTIALS, password: 'short' }), /invalid field/);
    const { user, ...missingUser } = CREDENTIALS;
    assert.throws(() => validateEmailCredentials(missingUser), /approved contract/);
  });

  it('treats an absent file as an unconfigured channel', () => {
    assert.equal(readEmailCredentials(join(workspace, 'absent.json'), { ownerUid: process.getuid(), serviceGid: process.getgid() }), null);
  });

  it('refuses a credentials file that is readable by other users', () => {
    const path = join(workspace, 'loose.json');
    writeFileSync(path, JSON.stringify(CREDENTIALS), { mode: 0o644 });
    chmodSync(path, 0o644);
    const ownership = { ownerUid: process.getuid(), serviceGid: process.getgid() };
    assert.throws(() => readEmailCredentials(path, ownership), /unsafe ownership/);
    chmodSync(path, 0o600);
    assert.deepEqual(readEmailCredentials(path, ownership), CREDENTIALS);
  });
});

describe('reset recipients', () => {
  const token = 'a'.repeat(64);

  it('builds the admin reset link the dashboard actually reads', () => {
    assert.equal(
      buildPasswordResetUrl({ adminOrigin: 'http://127.0.0.1:9000/', token }),
      'http://127.0.0.1:9000/app/reset-password?token=' + token,
    );
  });

  it('accepts an admin user and lowercases the address', () => {
    const recipient = passwordResetRecipient({
      event: { data: { actor_type: 'user', entity_id: 'Owner@Example.Test', token } },
      adminOrigin: 'http://127.0.0.1:9000',
    });
    assert.equal(recipient.supported, true);
    assert.equal(recipient.to, 'owner@example.test');
    assert.ok(recipient.resetUrl.endsWith(token));
  });

  it('stays silent for an actor type this deployment cannot serve', () => {
    // The storefront is a static site with no reset page, so a customer link
    // would lead nowhere. Sending it would be worse than not sending at all.
    const recipient = passwordResetRecipient({
      event: { data: { actor_type: 'customer', entity_id: 'buyer@example.test', token } },
      adminOrigin: 'http://127.0.0.1:9000',
    });
    assert.equal(recipient.supported, false);
    assert.match(recipient.reason, /customer/);
  });

  it('refuses an event without a usable token or address', () => {
    assert.equal(passwordResetRecipient({ event: { data: { actor_type: 'user', entity_id: 'owner@example.test', token: 'short' } }, adminOrigin: 'http://127.0.0.1:9000' }).supported, false);
    assert.equal(passwordResetRecipient({ event: { data: { actor_type: 'user', entity_id: 'not-an-address', token } }, adminOrigin: 'http://127.0.0.1:9000' }).supported, false);
  });
});

describe('reset message body', () => {
  it('tells the recipient about the SSH tunnel only when the link needs one', () => {
    const loopback = buildPasswordResetMessage({
      from: 'owner@example.test', to: 'owner@example.test',
      resetUrl: 'http://127.0.0.1:9000/app/reset-password?token=abc',
    });
    assert.match(decodeBase64Body(loopback), /SSH 隧道/);
    const publicLink = buildPasswordResetMessage({
      from: 'owner@example.test', to: 'owner@example.test',
      resetUrl: 'https://admin.pawlivora.com/app/reset-password?token=abc',
    });
    assert.doesNotMatch(decodeBase64Body(publicLink), /SSH 隧道/);
  });
});

describe('delivery over a real SMTP session', () => {
  it('delivers over implicit TLS and authenticates before sending', async () => {
    const sink = await startSmtpSink({ ...certificate, mode: 'implicit' });
    try {
      const recipient = { supported: true, to: 'owner@example.test', resetUrl: 'http://127.0.0.1:9000/app/reset-password?token=' + 'b'.repeat(64) };
      const result = await deliverPasswordReset({
        recipient,
        credentials: { ...CREDENTIALS, port: sink.port },
        sendOptions: { ca: certificate.cert },
      });
      assert.deepEqual(result, { delivered: true, to: 'owner@example.test' });
      assert.equal(sink.messages.length, 1);
      assert.equal(sink.messages[0].authenticated, true);
      assert.equal(sink.messages[0].to, 'owner@example.test');
      assert.ok(decodeBase64Body(sink.messages[0].body).includes(recipient.resetUrl));
      // The credential must never appear in what was transmitted as the message.
      assert.doesNotMatch(sink.messages[0].body, /app-password-1234/);
    } finally {
      await sink.close();
    }
  });

  it('delivers over STARTTLS, upgrading before the credential is written', async () => {
    const sink = await startSmtpSink({ ...certificate, mode: 'starttls' });
    try {
      const message = 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset="utf-8"\r\n\r\nb2s=\r\n';
      const result = await sendMessage({
        host: '127.0.0.1', port: sink.port, secure: false,
        user: CREDENTIALS.user, password: CREDENTIALS.password,
        from: CREDENTIALS.from, to: CREDENTIALS.from, message,
        ca: certificate.cert,
      });
      assert.deepEqual(result, { delivered: true });
      assert.equal(sink.messages.length, 1);
      assert.equal(sink.messages[0].authenticated, true);
    } finally {
      await sink.close();
    }
  });

  it('restores a body line that begins with a dot', async () => {
    const sink = await startSmtpSink({ ...certificate, mode: 'implicit' });
    try {
      const message = 'Content-Type: text/plain\r\n\r\nfirst\r\n.hidden line\r\nlast';
      await sendMessage({
        host: '127.0.0.1', port: sink.port, secure: true,
        user: CREDENTIALS.user, password: CREDENTIALS.password,
        from: CREDENTIALS.from, to: CREDENTIALS.from, message,
        ca: certificate.cert,
      });
      assert.ok(sink.messages[0].body.endsWith('first\r\n.hidden line\r\nlast'));
    } finally {
      await sink.close();
    }
  });

  it('reports a refused credential instead of claiming delivery', async () => {
    const sink = await startSmtpSink({ ...certificate, mode: 'implicit' });
    try {
      const result = await deliverPasswordReset({
        recipient: { supported: true, to: 'owner@example.test', resetUrl: 'http://127.0.0.1:9000/app/reset-password?token=' + 'c'.repeat(64) },
        credentials: { ...CREDENTIALS, port: sink.port, password: 'wrong-app-password' },
        sendOptions: { ca: certificate.cert },
      });
      assert.equal(result.delivered, false);
      assert.match(result.reason, /code 535/);
      assert.match(result.reason, /stage credentials/);
      assert.equal(sink.messages.length, 0);
    } finally {
      await sink.close();
    }
  });

  it('reports a refused recipient instead of claiming delivery', async () => {
    const sink = await startSmtpSink({ ...certificate, mode: 'implicit', rejectRecipient: true });
    try {
      const result = await deliverPasswordReset({
        recipient: { supported: true, to: 'nobody@example.test', resetUrl: 'http://127.0.0.1:9000/app/reset-password?token=' + 'd'.repeat(64) },
        credentials: { ...CREDENTIALS, port: sink.port },
        sendOptions: { ca: certificate.cert },
      });
      assert.equal(result.delivered, false);
      assert.match(result.reason, /code 550/);
    } finally {
      await sink.close();
    }
  });

  it('names the missing relay instead of attempting a connection', async () => {
    const result = await deliverPasswordReset({
      recipient: { supported: true, to: 'owner@example.test', resetUrl: 'http://127.0.0.1:9000/app/reset-password?token=' + 'e'.repeat(64) },
      credentials: null,
    });
    assert.deepEqual(result, { delivered: false, reason: 'no email relay is configured' });
  });

  it('refuses to send when the event has no servable recipient', async () => {
    const result = await deliverPasswordReset({ recipient: { supported: false, reason: 'unsupported' }, credentials: CREDENTIALS });
    assert.deepEqual(result, { delivered: false, reason: 'unsupported' });
  });
});
