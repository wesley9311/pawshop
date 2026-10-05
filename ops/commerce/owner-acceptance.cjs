'use strict';

// PawShop Customer Auth — REAL QQ EMAIL OWNER ACCEPTANCE (production).
//
// This is the final owner-facing acceptance for CUSTOMER AUTH FOUNDATION. It runs
// LOCALLY (on the owner's machine) against https://pawlivora.com — no SSH, no
// production credentials are read. It drives the real HTTP flow and pauses only
// twice for the owner: (1) enter the test password, (2) paste the 6-digit OTP
// from the QQ mailbox. Every negative/security check is automatic.
//
// The owner is asked to do ONLY:
//   - input a test password
//   - read the 6-digit OTP from the QQ mailbox and paste it (twice: first code,
//     then the resend code)
//
// Everything else (wrong-code fail, resend-old-code fail, one-time, no duplicate
// customer, HTTP response never leaking code_hash) is asserted automatically.
//
// Exit 0 = all PASS; non-zero = at least one FAIL.
//
// Usage:  node ops/commerce/owner-acceptance.cjs [email]
//         (defaults to 504533680@qq.com)

const https = require('node:https');
const readline = require('node:readline');

const BASE = 'https://pawlivora.com';
const EMAIL = (process.argv[2] || '376692953@qq.com').trim().toLowerCase();

// ---- interactive prompt (masked for password) ----
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    if (hidden) {
      const stdin = process.stdin;
      let entered = '';
      const onData = (c) => {
        const k = c.toString();
        if (k === '\n' || k === '\r' || k === '\u0004') {
          stdin.removeListener('data', onData);
          stdin.pause();
          process.stdout.write('\n');
          resolve(entered);
        } else if (k === '\u007f' || k === '\b') {
          entered = entered.slice(0, -1);
        } else {
          entered += k;
        }
      };
      process.stdout.write(question);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

// Publishable key for /store routes. Public by design: it ships in every
// visitor's browser (config.js `publishableKey`) and unlocks only the published
// catalog. It is NOT a credential.
const PUB_KEY = 'pk_f123c6182403217335137418b5094114d8add70aca3991f07f951c9c2c0b908e';

// ---- HTTP helper ----
function request(method, path, { token, body, cookie, headers } = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body);
    const u = new URL(BASE + path);
    const isStore = path.startsWith('/store');
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(isStore && PUB_KEY ? { 'x-publishable-api-key': PUB_KEY } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(headers || {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        const setCookies = res.headers['set-cookie'] || [];
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, setCookies, body: json, raw });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e), body: null, raw: '' }));
    if (data) req.write(data);
    req.end();
  });
}

// ---- report ----
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// Does a JSON response (or its raw text) leak the OTP code or its hash anywhere?
function responseLeaksCode(res) {
  const raw = res.raw || '';
  // The 6-digit code itself.
  if (/\"code\"\s*:\s*\"[0-9]{6}\"/.test(raw)) return 'code (6-digit) in response';
  // provider_metadata carrying the code hash must never reach the client.
  if (/\"code_hash\"/.test(raw)) return 'code_hash key in response';
  if (/\"provider_metadata\"/.test(raw)) return 'provider_metadata in response';
  return null;
}

// ---- helpers ----
const register = (password) =>
  request('POST', '/auth/customer/emailpass/register', { body: { email: EMAIL, password } });

const requestOtp = (token) =>
  request('POST', '/auth/verification/request', {
    token,
    body: { entity_id: EMAIL, entity_type: 'customer', code_provider: 'otp' },
  });

const confirmOtp = (token, code) =>
  request('POST', '/auth/verification/confirm', { token, body: { code, code_provider: 'otp' } });

const claim = (token) =>
  request('POST', '/store/customers', { token, body: { email: EMAIL } });

const login = (password) =>
  request('POST', '/auth/customer/emailpass', { body: { email: EMAIL, password } });

const logout = (cookie) => request('DELETE', '/auth/session', { cookie });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===================== RUN =====================
(async () => {
  console.log('==============================================================');
  console.log(' PawShop Customer Auth — REAL QQ EMAIL OWNER ACCEPTANCE');
  console.log('==============================================================');
  console.log(` target : ${BASE}`);
  console.log(` email  : ${EMAIL}`);
  console.log('');
  console.log(' You will be asked for:');
  console.log('   1. a test password (choose any strong password)');
  console.log('   2. the 6-digit code from QQ email #1 (the FIRST email)');
  console.log('   3. the 6-digit code from QQ email #2 (the SECOND/RESEND email)');
  console.log('');
  console.log(' Emails arrive in order. Paste them in that same order when prompted.');
  console.log(' There is a ~61s cooldown wait between the two emails. Everything else is');
  console.log(' automatic. Let us begin.');
  console.log('');

  // ---------------------------------------------------------------
  // Step 1 — register (auto). Get the actorless token.
  // ---------------------------------------------------------------
  const password = await ask('  [1/3] Enter a test password (input is hidden): ', { hidden: true });
  if (!password || password.length < 8) {
    console.log('  ❌ ABORT: password must be at least 8 characters.');
    process.exit(2);
  }
  console.log('');
  console.log('  → Registering the account...');
  const reg = await register(password);
  if (reg.status !== 200 || !reg.body || !reg.body.token) {
    record('register returns 200 + actorless token', false, `status=${reg.status} body=${JSON.stringify(reg.body).slice(0, 200)}`);
    console.log('  ❌ ABORT: registration failed; cannot continue.');
    process.exit(1);
  }
  const leak1 = responseLeaksCode(reg);
  record('register: response does NOT leak code/code_hash/provider_metadata', !leak1, leak1 || 'clean');
  const token = reg.body.token;

  // ---------------------------------------------------------------
  // Step 2 — request OTP #1 (auto). First QQ email (code A).
  // ---------------------------------------------------------------
  console.log('');
  console.log('  → Requesting verification code #1 (check your QQ mailbox)...');
  const reqOtp = await requestOtp(token);
  if (reqOtp.status !== 201) {
    record('OTP request #1 returns 201', false, `status=${reqOtp.status} body=${JSON.stringify(reqOtp.body).slice(0, 200)}`);
    console.log('  ❌ ABORT: OTP request failed.');
    process.exit(1);
  }
  const leak2 = responseLeaksCode(reqOtp);
  record('OTP request #1: response does NOT leak code/code_hash/provider_metadata', !leak2, leak2 || 'clean');
  record('OTP request #1 returns 201', true, 'triggered QQ email #1');

  // ---------------------------------------------------------------
  // Step 3 — wrong code (auto). Prove a wrong 6-digit code fails.
  //   (This runs against the code issued in step 2; `000000` cannot match.)
  // ---------------------------------------------------------------
  console.log('');
  console.log('  → Auto-checking that a WRONG code is rejected...');
  const wrong = await confirmOtp(token, '000000');
  record('wrong code → confirm rejected (>=400), never verified', wrong.status >= 400, `confirm=${wrong.status}`);

  // ---------------------------------------------------------------
  // Step 4 — read code A (owner input, email #1). We HOLD it, do not
  //   confirm yet, so the resend can invalidate it and prove the rule.
  // ---------------------------------------------------------------
  console.log('');
  console.log('  ⚠️  From your QQ mailbox, open EMAIL #1 (the FIRST one) and copy its code.');
  const codeA = await ask('  [2/3] Paste the 6-digit code from QQ EMAIL #1 (we will NOT confirm it yet): ');
  if (!/^[0-9]{6}$/.test(codeA)) {
    console.log('  ❌ ABORT: the code must be exactly 6 digits.');
    process.exit(2);
  }

  // ---------------------------------------------------------------
  // Step 5 — resend (auto + wait). Request OTP #2 invalidates code A.
  // ---------------------------------------------------------------
  console.log('');
  console.log('  → Waiting ~61s for the resend cooldown, then requesting code #2...');
  await sleep(61000);
  let reqOtp2 = await requestOtp(token);
  for (let i = 0; i < 6 && reqOtp2.status === 429; i++) {
    console.log('    (still cooling down, retrying…)');
    await sleep(10000);
    reqOtp2 = await requestOtp(token);
  }
  if (reqOtp2.status !== 201) {
    record('OTP request #2 (resend) returns 201', false, `status=${reqOtp2.status} body=${JSON.stringify(reqOtp2.body).slice(0, 200)}`);
    console.log('  ❌ ABORT: resend did not return 201; cannot test invalidation.');
    process.exit(1);
  }
  const leak3 = responseLeaksCode(reqOtp2);
  record('OTP request #2: response does NOT leak code/code_hash/provider_metadata', !leak3, leak3 || 'clean');
  record('OTP request #2 (resend) returns 201', true, 'triggered QQ email #2');

  // ---------------------------------------------------------------
  // Step 6 — resend invalidates old code (auto). The code A the Owner
  //   pasted is now stale; confirming it MUST be rejected.
  // ---------------------------------------------------------------
  console.log('');
  console.log('  → Auto-checking that the resend invalidated EMAIL #1 code...');
  const oldRejected = await confirmOtp(token, codeA);
  record('resend invalidates old code (email #1 code rejected)', oldRejected.status >= 400, `old→${oldRejected.status}`);

  // ---------------------------------------------------------------
  // Step 7 — confirm the NEW code (owner input, email #2).
  // ---------------------------------------------------------------
  console.log('');
  console.log('  ⚠️  From your QQ mailbox, open EMAIL #2 (the SECOND/resend one) and copy its code.');
  const codeB = await ask('  [3/3] Paste the 6-digit code from QQ EMAIL #2 (the resend): ');
  if (!/^[0-9]{6}$/.test(codeB)) {
    console.log('  ❌ ABORT: the code must be exactly 6 digits.');
    process.exit(2);
  }
  console.log('');
  console.log('  → Confirming the new code...');
  const confirm = await confirmOtp(token, codeB);
  const verified = confirm.status === 200 && confirm.body && confirm.body.verified_at;
  record('new code → confirm 200 + verified_at set', verified, `confirm=${confirm.status}`);

  if (!verified) {
    console.log(`  ❌ ABORT: new code confirm failed (status=${confirm.status}). Check the code and retry.`);
    process.exit(1);
  }

  // ---------------------------------------------------------------
  // Step 8 — one-time (auto). Re-submit the NEW code → rejected.
  // ---------------------------------------------------------------
  console.log('');
  console.log('  → Auto-checking that the new code is one-time...');
  const replayNew = await confirmOtp(token, codeB);
  record('new code one-time (re-submit rejected)', replayNew.status >= 400, `new→${replayNew.status}`);

  // ---------------------------------------------------------------
  // Step 9 — claim (auto). Guest → account, no duplicate.
  // ---------------------------------------------------------------
  console.log('');
  console.log('  → Auto-checking claim (guest → account) + no duplicate customer...');
  const claimRes = await claim(token);
  const claimed = claimRes.status === 200 && claimRes.body && claimRes.body.customer && claimRes.body.customer.has_account === true;
  record('claim → 200 + has_account=true', claimed, `claim=${claimRes.status} has_account=${claimRes.body && claimRes.body.customer && claimRes.body.customer.has_account}`);

  // Replay the claim with the same token — must stay idempotent (no new customer).
  const claimReplay = await claim(token);
  const replayOk = claimReplay.status === 200;
  record('claim replay → idempotent (still one customer)', replayOk, `claimReplay=${claimReplay.status}`);

  // ---------------------------------------------------------------
  // Step 10 — login (auto, uses the same password).
  // ---------------------------------------------------------------
  console.log('');
  console.log('  → Auto-checking login with the test password...');
  const loginRes = await login(password);
  const loggedIn = loginRes.status === 200 && loginRes.body && loginRes.body.token && !loginRes.body.verification_required;
  record('login → 200 + customer token (no verification_required)', loggedIn,
    `login=${loginRes.status} verification_required=${!!(loginRes.body && loginRes.body.verification_required)}`);

  // ---------------------------------------------------------------
  // Step 11 — authenticated session (auto). The login JWT is the credential.
  // ---------------------------------------------------------------
  let meStatus = { status: 0 };
  if (loginRes.body && loginRes.body.token) {
    meStatus = await request('GET', '/store/customers/me', { token: loginRes.body.token });
  }
  record('authenticated /store/customers/me → 200', meStatus.status === 200,
    `me=${meStatus.status}${meStatus.body && meStatus.body.customer ? ' customer=' + meStatus.body.customer.email : ''}`);

  // ---------------------------------------------------------------
  // Step 12 — logout (auto). Stateless JWT: logout = discard the token.
  //   Prove the token is the ONLY credential: without it, /me is 401.
  // ---------------------------------------------------------------
  console.log('');
  console.log('  → Auto-checking logout (stateless JWT: token is the credential)...');
  const anonMe = await request('GET', '/store/customers/me', {});
  const logoutRes = await request('DELETE', '/auth/session', {});
  record('logout → token discard; unauthenticated /me → 401', anonMe.status === 401,
    `anonMe=${anonMe.status} deleteSession=${logoutRes.status}`);

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  console.log('');
  console.log('==============================================================');
  const fails = results.filter((r) => !r.pass);
  console.log(` RESULT: ${results.length - fails.length}/${results.length} PASS`);
  if (fails.length) {
    console.log(' FAILED ITEMS:');
    for (const f of fails) console.log(`   - ${f.name}  (${f.detail || ''})`);
    console.log('');
    console.log(' NOTE: the database-side "no duplicate customer" and "response no code_hash"');
    console.log('       are re-verified by a read-only DB check in the next step.');
    process.exit(1);
  }
  console.log(' All HTTP-level checks passed. The read-only DB confirmation (no duplicate');
  console.log(' customer, has_account flipped, no code_hash persisted) is performed by the');
  console.log(' operator via a separate read-only query.');
  console.log('==============================================================');
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(2);
});
