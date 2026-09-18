#!/usr/bin/env node
// Install the password-reset mail relay credential.
//
// The order of operations is the point of this script. A credential file that
// merely looks well-formed is not evidence that the mailbox will accept it, and
// installing a bad one would leave "forgot password" answering 201 while
// nothing arrives - the exact silent failure this project keeps having to
// remove. So the candidate credential is used to send one real message first,
// and only a relay that accepts it is allowed to be written to /etc.
//
// The authorization code is read from a file, from stdin, or from the terminal
// with echo disabled, and is never placed in a command line, an environment
// variable, or a log line.
//
//   set-email-credentials.mjs --code-file /root/.qq-smtp-code
//   set-email-credentials.mjs                 # prompts on a terminal
//   set-email-credentials.mjs --selftest      # exercises everything locally
//
// --selftest needs no real mailbox and writes nothing outside a temporary
// directory: it stands up a throwaway TLS relay, points the probe at it, and
// checks both the accepted and the refused outcome. It cannot prove that
// smtp.qq.com trusts this host, and it does not claim to.

import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, constants, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { createServer as createTlsServer } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const CREDENTIALS_PATH = '/etc/pawshop/email-credentials.json';
const CREDENTIALS_DIRECTORY = '/etc/pawshop';
const SERVICE_USER = 'pawshop';
const DEFAULT_ADDRESS = '504533680@qq.com';
const DEFAULT_HOST = 'smtp.qq.com';
const DEFAULT_PORT = 465;
// QQ hands out a 16-character code. The bound is looser on purpose: a provider
// that changes its format must not require a code change here, but a stray paste
// (a whole sentence, a password with punctuation) is refused.
const CODE_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const EXPECTED_CODE_LENGTH = 16;

const usage = 'usage: set-email-credentials.mjs [--address EMAIL] [--code-file PATH] [--selftest] [--selftest-ca PATH] [--no-end-to-end]';

function parseArguments(argv) {
  const options = { address: DEFAULT_ADDRESS, codeFile: null, selftest: false, selftestCa: null, endToEnd: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--selftest') { options.selftest = true; continue; }
    if (flag === '--no-end-to-end') { options.endToEnd = false; continue; }
    if (flag === '--address' || flag === '--code-file' || flag === '--selftest-ca') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error(`${flag} needs a value. ${usage}`);
      }
      index += 1;
      if (flag === '--address') options.address = value;
      else if (flag === '--code-file') options.codeFile = value;
      else options.selftestCa = value;
      continue;
    }
    throw new Error(`Unrecognised argument ${flag}. ${usage}`);
  }
  // A trust anchor other than the system store is a test-only affordance; it can
  // never be combined with a real installation.
  if (options.selftestCa && !options.selftest) {
    throw new Error(`--selftest-ca is only accepted together with --selftest. ${usage}`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/.test(options.address)) {
    throw new Error('The mail address for the relay credential is invalid.');
  }
  return options;
}

function requireRoot() {
  if (process.platform !== 'linux' || process.getuid() !== 0) {
    throw new Error('Installing a mail relay credential requires root on Linux.');
  }
}

function releaseDirectory() {
  const server = '/srv/pawshop-commerce/current/_commerce/.medusa/server';
  const stat = lstatSync(server, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('The active release has no compiled server directory.');
  }
  return server;
}

function serviceIds() {
  const uid = Number(execFileSync('/usr/bin/id', ['-u', SERVICE_USER], { encoding: 'utf8' }).trim());
  const gid = Number(execFileSync('/usr/bin/id', ['-g', SERVICE_USER], { encoding: 'utf8' }).trim());
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) {
    throw new Error(`The ${SERVICE_USER} service identity could not be resolved.`);
  }
  return { uid, gid };
}

function promptSecret(label) {
  if (!process.stdin.isTTY) return null;
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (character === '\u007f' || character === '\b') { value = value.slice(0, -1); continue; }
        value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function readAuthorizationCode({ codeFile }) {
  let raw;
  if (codeFile) {
    const stat = lstatSync(codeFile, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('The file holding the authorization code is missing or unsafe.');
    }
    raw = readFileSync(codeFile, 'utf8');
  } else if (process.stdin.isTTY) {
    raw = await promptSecret('QQ 邮箱授权码（输入时不显示）: ');
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString('utf8');
  }
  const code = String(raw).trim();
  if (!CODE_PATTERN.test(code)) {
    throw new Error('The authorization code must be a single token of letters and digits; a password or a pasted sentence is refused.');
  }
  if (code.length !== EXPECTED_CODE_LENGTH) {
    process.stderr.write(`warning: the code is ${code.length} characters; QQ normally issues ${EXPECTED_CODE_LENGTH}.\n`);
  }
  return code;
}

function buildCredentials({ address, code }) {
  // Field order is irrelevant to the contract (it compares sorted keys) but kept
  // stable so two runs of this script produce a byte-identical file.
  return { from: address, host: DEFAULT_HOST, password: code, port: DEFAULT_PORT, secure: true, user: address };
}

function validateAgainstRunningCode(credentials) {
  const { validateEmailCredentials } = require(join(releaseDirectory(), 'src', 'lib', 'email-channel.cjs'));
  return validateEmailCredentials(credentials);
}

function buildSelfTestMessage({ address }) {
  const { buildMessage } = require(join(releaseDirectory(), 'src', 'lib', 'smtp-client.cjs'));
  return buildMessage({
    from: address,
    to: address,
    subject: 'PawShop 邮件通道自检',
    body: [
      '这是 PawShop 生产主机的邮件通道自检。',
      '',
      '收到这封邮件说明发信凭据是有效的：后台的"忘记密码"会通过同一个通道',
      '把重置链接发到这个邮箱，以后小团队成员的账号也一样。',
      '',
      '这不是重置邮件，不需要你做任何操作。',
      '',
    ].join('\n'),
    messageId: `<selftest-${Date.now()}@pawlivora.com>`,
    date: new Date().toUTCString(),
  });
}

// The probe sends a real message through the same transport the reset mail uses.
// It is not a login check dressed up as a delivery check: a relay that accepts
// the credential and then refuses the recipient would pass a login-only probe
// and still lose every reset mail.
async function probe({ credentials, message, ca }) {
  const { sendMessage } = require(join(releaseDirectory(), 'src', 'lib', 'smtp-client.cjs'));
  await sendMessage({
    host: credentials.host, port: credentials.port, secure: credentials.secure,
    user: credentials.user, password: credentials.password,
    from: credentials.from, to: credentials.from, message,
    ...(ca ? { ca } : {}),
  });
}

function installCredentials({ credentials, gid }) {
  const target = lstatSync(CREDENTIALS_PATH, { throwIfNoEntry: false });
  if (target && (!target.isFile() || target.isSymbolicLink())) {
    throw new Error('The credential path exists and is not a regular file.');
  }
  const staging = join(CREDENTIALS_DIRECTORY, `.email-credentials.${process.pid}.tmp`);
  const descriptor = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(credentials)}\n`);
  } finally {
    closeSync(descriptor);
  }
  // install(1) replaces the file in one step and applies the final ownership and
  // mode, so a half-written credential is never visible to the service.
  const installed = spawnSync('/usr/bin/install', ['-o', 'root', '-g', `${gid}`, '-m', '0640', staging, CREDENTIALS_PATH], { encoding: 'utf8' });
  rmSync(staging, { force: true });
  if (installed.status !== 0) throw new Error('The credential file could not be installed.');
}

// The definitive check on ownership and mode is the service identity itself: the
// file passes only if the account that runs the commerce process can read it.
function assertServiceCanRead({ uid, gid }) {
  const verifier = [
    "const channel = require(process.argv[1]);",
    'try {',
    `  const loaded = channel.readEmailCredentials(undefined, { serviceGid: Number(process.argv[2]) });`,
    "  process.exit(loaded ? 0 : 3);",
    '} catch (error) { process.stderr.write(String(error.message) + "\\n"); process.exit(4); }',
  ].join('\n');
  const result = spawnSync('/usr/bin/setpriv', [
    `--reuid=${uid}`, `--regid=${gid}`, '--clear-groups',
    '/usr/bin/node', '-e', verifier, join(releaseDirectory(), 'src', 'lib', 'email-channel.cjs'), `${gid}`,
  ], { encoding: 'utf8' });
  if (result.status === 3) throw new Error('The credential file is not visible to the commerce service identity.');
  if (result.status !== 0) {
    throw new Error(`The commerce service identity cannot use the credential file: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
  }
}

async function install({ address, code, endToEnd }) {
  requireRoot();
  const { uid, gid } = serviceIds();
  const credentials = buildCredentials({ address, code });
  validateAgainstRunningCode(credentials);
  process.stdout.write(`Probing ${credentials.host}:${credentials.port} by sending one self-check message to ${address} ...\n`);
  try {
    await probe({ credentials, message: buildSelfTestMessage({ address }) });
  } catch (error) {
    throw new Error(`The relay refused the self-check, so nothing was installed: ${error.message}${error.code ? ` (code ${error.code}, stage ${error.stage})` : ''}`);
  }
  process.stdout.write('The relay accepted the credential and the message.\n');
  installCredentials({ credentials, gid });
  process.stdout.write(`Installed ${CREDENTIALS_PATH} (root:${SERVICE_USER} 0640).\n`);
  assertServiceCanRead({ uid, gid });
  process.stdout.write('The commerce service identity can read it.\n');
  if (!endToEnd) return;
  const verification = spawnSync('/root/run-password-reset-verification.sh', ['delivered'], { encoding: 'utf8' });
  process.stdout.write(verification.stdout || '');
  if (verification.status !== 0) {
    process.stderr.write(verification.stderr || '');
    throw new Error('The credential was installed, but the end-to-end reset check did not pass; treat the channel as unverified.');
  }
}

// A throwaway relay for --selftest. It is deliberately dumb: it speaks just
// enough SMTP for the probe, and on request it refuses the credential so the
// failure path is exercised too.
function startSelfTestRelay({ certPem, keyPem, rejectAuthentication }) {
  const deliveries = [];
  const server = createTlsServer({ cert: certPem, key: keyPem }, (socket) => {
    let buffer = '';
    let mode = 'command';
    let body = '';
    const send = (line) => socket.write(`${line}\r\n`);
    let stage = 'ehlo';
    send('220 selftest ESMTP');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const breakIndex = buffer.indexOf('\r\n');
        if (breakIndex < 0) return;
        const line = buffer.slice(0, breakIndex);
        buffer = buffer.slice(breakIndex + 2);
        if (mode === 'data') {
          if (line === '.') {
            deliveries.push(body);
            body = '';
            mode = 'command';
            send('250 2.0.0 Ok');
          } else {
            body += `${line}\n`;
          }
          continue;
        }
        if (/^EHLO /.test(line)) { socket.write('250-selftest\r\n250 AUTH LOGIN\r\n'); stage = 'auth-user'; continue; }
        if (stage === 'auth-user' && /^AUTH LOGIN$/i.test(line)) { send('334 VXNlcm5hbWU6'); stage = 'auth-password'; continue; }
        if (stage === 'auth-password') { send('334 UGFzc3dvcmQ6'); stage = 'auth-verdict'; continue; }
        if (stage === 'auth-verdict') {
          if (rejectAuthentication) { send('535 5.7.8 Authentication credentials invalid'); socket.end(); return; }
          send('235 2.7.0 Authentication successful');
          stage = 'mail';
          continue;
        }
        if (/^MAIL FROM:/i.test(line) || /^RCPT TO:/i.test(line)) { send('250 2.1.0 Ok'); continue; }
        if (/^DATA$/i.test(line)) { mode = 'data'; send('354 End data with <CR><LF>.<CR><LF>'); continue; }
        if (/^QUIT$/i.test(line)) { send('221 2.0.0 Bye'); socket.end(); continue; }
        send('502 5.5.2 Command not implemented');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, deliveries, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

async function runSelfTest({ address, code, caPath }) {
  const directory = mkdtempSync(join(tmpdir(), 'pawshop-selftest-'));
  let relay = null;
  try {
    const key = join(directory, 'key.pem');
    const cert = join(directory, 'cert.pem');
    execFileSync('/usr/bin/openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', key, '-out', cert, '-subj', '/CN=selftest',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ], { stdio: 'ignore' });
    const trustAnchor = caPath || cert;
    const certPem = readFileSync(cert, 'utf8');
    const keyPem = readFileSync(key, 'utf8');
    // The real credential is validated first, at the real port: the local relay
    // is only a substitute for the network, not for the contract.
    validateAgainstRunningCode(buildCredentials({ address, code }));
    const credentials = { ...buildCredentials({ address, code }), host: '127.0.0.1' };

    relay = await startSelfTestRelay({ certPem, keyPem, rejectAuthentication: false });
    credentials.port = relay.port;
    await probe({ credentials, message: buildSelfTestMessage({ address }), ca: readFileSync(trustAnchor, 'utf8') });
    if (relay.deliveries.length !== 1) {
      throw new Error(`The self-test relay recorded ${relay.deliveries.length} messages; exactly one was expected.`);
    }
    process.stdout.write('self-test: the accepted path delivered exactly one message.\n');
    await relay.close();
    relay = await startSelfTestRelay({ certPem, keyPem, rejectAuthentication: true });
    credentials.port = relay.port;
    let refused = false;
    try {
      await probe({ credentials, message: buildSelfTestMessage({ address }), ca: readFileSync(trustAnchor, 'utf8') });
    } catch (error) {
      refused = error?.code === '535' && error?.stage === 'credentials';
    }
    if (!refused) throw new Error('A relay that refuses the credential was not reported as an authentication failure.');
    process.stdout.write('self-test: the refused path is reported as an authentication failure.\n');
    process.stdout.write('self-test passed. Nothing was written outside the temporary directory.\n');
  } finally {
    if (relay) await relay.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// Every refusal is reported as one line. A stack trace would bury the reason
// under Node's internals, and the person running this needs the reason.
try {
  const options = parseArguments(process.argv.slice(2));
  if (options.selftest) {
    // The self-test relay checks nothing, so a placeholder code is enough; a real
    // code can still be supplied to exercise the acquisition path.
    const code = options.codeFile
      ? await readAuthorizationCode({ codeFile: options.codeFile })
      : 'selftestcode1234';
    await runSelfTest({ address: options.address, code, caPath: options.selftestCa });
  } else {
    const code = await readAuthorizationCode({ codeFile: options.codeFile });
    await install({ address: options.address, code, endToEnd: options.endToEnd });
  }
} catch (error) {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exit(1);
}
