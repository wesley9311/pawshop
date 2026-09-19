#!/usr/bin/env node
// Acceptance for the password-reset email channel.
//
// The failure this guards against is silence. Medusa answers 201 to "forgot
// password" whether a mail was delivered, refused, or never attempted, so none
// of those are evidence: a credential file on disk only proves that somebody
// wrote a file, and 201 only proves that a route exists. The one honest witness
// is the subscriber's own line in the service journal for the request just
// made, which is why this verification drives the real endpoint and then reads
// what the running code said about it.
//
// The expected outcome is passed in rather than inferred, and it has to agree
// with the credential file's own state. Without that cross-check the caller
// could watch what happened and then write it down as the expectation, which is
// how a test stops being a test.
//
// Run it from outside the release: adding a file to a release directory breaks
// the release manifest, whose file set is compared verbatim.
//
//   node verify-password-reset-delivery.mjs <release> <releaseId> delivered|no-relay

import { execFileSync, spawnSync } from 'node:child_process';
import { constants, closeSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const UNIT = 'pawshop-commerce.service';
const OUTCOME_TIMEOUT_MS = 30000;
const OWNER_CREDENTIALS = '/root/pawshop-production-owner-credentials.json';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 5) {
  throw new Error('Password-reset delivery verification requires root on Linux, an exact release identity, and an expected outcome.');
}
const release = resolve(process.argv[2] || '');
const releaseId = process.argv[3];
const expected = process.argv[4];
if (!/^[0-9a-f]{40}$/.test(releaseId || '') || release !== `/srv/pawshop-commerce/releases/${releaseId}`) {
  throw new Error('Password-reset verification release identity is invalid.');
}
if (!['delivered', 'no-relay'].includes(expected)) {
  throw new Error('The expected outcome must be exactly "delivered" or "no-relay".');
}

function privateSource(path, { gid = 0, mode = 0o600, maximum = 64 * 1024, label }) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== gid ||
      (stat.mode & 0o777) !== mode || stat.size <= 0 || stat.size > maximum) {
    throw new Error(`${label} has unsafe ownership, type, permissions, or size.`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(descriptor, 'utf8'); } finally { closeSync(descriptor); }
}

// The release owns the strict environment whitelist; reimplementing it here
// would create a second parser that could drift from the one the host enforces.
const { parseProductionEnvironmentFile } = require(join(release, '_commerce', 'scripts', 'production-env-file.cjs'));
// Loaded from the release for the same reason as the parser above: this verifier
// is also run from /root, where a relative path to the project would not resolve.
const { isProductionMode } = require(join(release, '_commerce', 'src', 'lib', 'production-modes.cjs'));

const pawshopGid = Number(execFileSync('/usr/bin/id', ['-g', 'pawshop'], { encoding: 'utf8' }).trim());
const ownerCredentials = JSON.parse(privateSource(OWNER_CREDENTIALS, { maximum: 4096, label: 'Owner credentials' }));
if (!ownerCredentials || Object.keys(ownerCredentials).sort().join('\0') !== 'email\0password' ||
    typeof ownerCredentials.email !== 'string' || typeof ownerCredentials.password !== 'string') {
  throw new Error('Production owner credentials do not match the approved contract.');
}
const environment = parseProductionEnvironmentFile(privateSource('/etc/pawshop/commerce.env', {
  gid: pawshopGid, mode: 0o640, label: 'Production environment',
}));
// A password reset has to be provable in either profile: the owner may lose the
// password at any time, and most likely while somebody is shopping.
if (environment.PAWSHOP_MIGRATIONS_CONFIRMED !== '1' || !isProductionMode(environment.PAWSHOP_MODE)) {
  throw new Error('Password-reset verification requires an activated production environment.');
}
if (!/^\d{2,5}$/.test(environment.PORT || '')) throw new Error('The production environment has no usable port.');
const origin = `http://127.0.0.1:${environment.PORT}`;

// The modules are loaded from the compiled server directory because that is what
// the service actually runs; the TypeScript sources are not the running code.
const channel = require(join(release, '_commerce', '.medusa', 'server', 'src', 'lib', 'email-channel.cjs'));
let credentialState;
try {
  credentialState = channel.readEmailCredentials(undefined, { serviceGid: pawshopGid }) ? 'configured' : 'absent';
} catch (error) {
  throw new Error(`The email credentials exist but the running code rejects them: ${error.message}`);
}
const required = credentialState === 'configured' ? 'delivered' : 'no-relay';
if (required !== expected) {
  throw new Error(`The expected outcome was "${expected}" but the credentials are ${credentialState}; refusing to grade the run against an expectation the host disagrees with.`);
}

function journalCursor() {
  const result = spawnSync('/usr/bin/journalctl', ['-u', UNIT, '-n', '0', '--show-cursor', '-o', 'cat'], { encoding: 'utf8' });
  // Which stream carries the cursor depends on the journalctl build, so both are read.
  const match = /^-- cursor: (.+)$/m.exec(`${result.stdout || ''}${result.stderr || ''}`);
  if (!match) throw new Error('Could not read the service journal cursor.');
  return match[1].trim();
}

// Only the `message` field is surfaced. The raw entries also carry the request
// metadata of every other request, and a reset token must never be printed.
function messagesAfter(cursor) {
  const result = spawnSync('/usr/bin/journalctl', ['-u', UNIT, `--after-cursor=${cursor}`, '-o', 'cat', '--no-pager'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Could not read the service journal after the reset request.');
  const messages = [];
  for (const line of (result.stdout || '').split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.message === 'string') messages.push(parsed.message);
    } catch {
      // Access-log and startup lines are not JSON messages; they are not needed here.
    }
  }
  return messages;
}

const cursor = journalCursor();
const response = await fetch(`${origin}/auth/user/emailpass/reset-password`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: ownerCredentials.email }),
  redirect: 'manual',
  signal: AbortSignal.timeout(8000),
});
if (response.status !== 201) {
  throw new Error(`The reset request did not answer 201; it answered ${response.status}.`);
}
await response.arrayBuffer();

const deadline = Date.now() + OUTCOME_TIMEOUT_MS;
let subscribers = 0;
let outcome = null;
for (;;) {
  const messages = messagesAfter(cursor);
  for (const message of messages) {
    const dispatched = /^Processing auth\.password_reset \(priority: \d+\) which has (\d+) subscribers$/.exec(message);
    if (dispatched) subscribers = Math.max(subscribers, Number(dispatched[1]));
    if (message.startsWith('password reset: ')) outcome = message;
  }
  if (subscribers > 0 && outcome) break;
  if (Date.now() >= deadline) break;
  await new Promise((settle) => setTimeout(settle, 1000));
}

if (subscribers === 0) {
  throw new Error('No auth.password_reset subscriber ran: this release does not deliver reset mail, so "forgot password" would still be silent.');
}
if (!outcome) {
  throw new Error(`The subscriber did not report an outcome within ${OUTCOME_TIMEOUT_MS}ms.`);
}

const delivered = `password reset: reset email delivered to ${ownerCredentials.email}`;
const absent = `password reset: no email sent to ${ownerCredentials.email} - no email relay is configured`;
if (expected === 'delivered') {
  if (outcome !== delivered) throw new Error(`Delivery was expected, but the subscriber reported: ${outcome}`);
  console.log(`Password reset delivery verified: the subscriber handed the message to the relay for ${ownerCredentials.email}.`);
} else {
  if (outcome !== absent) throw new Error(`An unconfigured channel was expected, but the subscriber reported: ${outcome}`);
  console.log('Password reset channel verified as deliberately unconfigured: the subscriber reported the missing relay instead of claiming success.');
}
