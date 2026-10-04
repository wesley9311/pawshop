'use strict';
// PawShop Customer Auth — Rollout C3 (P0 OTP fix) loopback acceptance harness.
//
// This REPLACES the C2 "simulate verified" shortcut: C2 set `verified_at` via a
// direct `UPDATE auth_verification` because the email code never left the server
// and the relay was blocked. That skipped the confirm endpoint entirely, which is
// exactly why the 6-digit-code P0 defect went unnoticed from Rollout B onward.
//
// C3 closes that gap. It runs against the isolated loopback server on
// 127.0.0.1:9100 (scratch DB `pawshop_looptest`) with the verification-email
// CAPTURE transport enabled (`PAWSHOP_VERIFICATION_EMAIL_CAPTURE`). The subscriber
// writes the REAL 6-digit code to a file; this harness reads it back and drives a
// REAL `POST /auth/verification/confirm` with the SAME code. No `UPDATE
// auth_verification SET verified_at` anywhere.
//
// Exit code 0 = all items PASS; non-zero = at least one FAIL.

const { execFileSync } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:9100';
const SCRATCH_DB = 'pawshop_looptest';
const TEST_DOMAIN = 'loopback.test';
const CAPTURE_DIR = process.env.PAWSHOP_VERIFICATION_EMAIL_CAPTURE || '/tmp/pawshop-otp-capture';
const rnd = () => crypto.randomBytes(6).toString('hex');

// ---- DB helpers (scratch DB only) ----
function sql(query) {
  const out = execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', SCRATCH_DB, '-tA', '-c', query], { encoding: 'utf8' });
  return out.trim();
}
function sqlRows(query) {
  const out = execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', SCRATCH_DB, '-tA', '-F', '\t', '-c', query], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.trim() !== '').map((l) => l.split('\t'));
}
function q(s) { return `'${String(s).replace(/'/g, "''")}'`; }

// Publishable API key read from the scratch DB (store routes require it).
let PUB_KEY = '';
try {
  PUB_KEY = sql(`select token from api_key where type = 'publishable' order by created_at limit 1;`);
} catch { PUB_KEY = ''; }

// ---- HTTP helper ----
function request(method, path, { token, body, cookie, headers } = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body);
    const isStore = path.startsWith('/store');
    const req = http.request(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
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
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e) }));
    if (data) req.write(data);
    req.end();
  });
}

// ---- report state ----
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---- helper: register a customer and return the actorless token ----
async function register(email, password = 'StrongPass-12345') {
  const r = await request('POST', '/auth/customer/emailpass/register', { body: { email, password } });
  return { status: r.status, token: r.body && r.body.token, body: r.body };
}

// ---- helper: request a verification code via the otp provider ----
async function requestOtp(token, email) {
  return await request('POST', '/auth/verification/request', {
    token,
    body: { entity_id: email, entity_type: 'customer', code_provider: 'otp' },
  });
}

// ---- helper: read the latest captured 6-digit code for an email from the
// capture directory (written by the verification-email subscriber). Returns the
// code string, or null when none is present yet. ----
function readCapturedCode(email) {
  try {
    const files = fs.readdirSync(CAPTURE_DIR).filter((f) => f.endsWith('.code')).sort();
    for (let i = files.length - 1; i >= 0; i--) {
      const content = fs.readFileSync(path.join(CAPTURE_DIR, files[i]), 'utf8');
      const lines = content.split('\n');
      if (lines[0] === email) {
        return lines[1] || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function clearCaptureDir() {
  try {
    for (const f of fs.readdirSync(CAPTURE_DIR)) {
      if (f.endsWith('.code')) fs.unlinkSync(path.join(CAPTURE_DIR, f));
    }
  } catch { /* dir may not exist yet */ }
}

// ---- helper: confirm a code for a given email (real confirm endpoint) ----
async function confirmOtp(token, code) {
  return await request('POST', '/auth/verification/confirm', {
    token,
    body: { code, code_provider: 'otp' },
  });
}

// ---- helper: full real verification flow — request → capture code → confirm.
// This is the end-to-end path the C2 harness skipped. ----
async function verifyReal(token, email, { waitMs = 400 } = {}) {
  const req = await requestOtp(token, email);
  if (req.status !== 201) return { req, confirm: null, code: null };
  // The subscriber runs asynchronously; poll briefly for the captured code.
  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    await new Promise((r) => setTimeout(r, waitMs));
    code = readCapturedCode(email);
  }
  if (!code) return { req, confirm: null, code: null };
  const confirm = await confirmOtp(token, code);
  return { req, confirm, code };
}

// ---- helper: seed a guest customer for a given email ----
function seedGuest(email, firstName = 'Guest', lastName = 'Buyer') {
  const id = `cus_guest_${rnd()}`;
  sql(`insert into customer (id, email, first_name, last_name, has_account, created_at, updated_at) values (${q(id)}, ${q(email)}, ${q(firstName)}, ${q(lastName)}, false, now(), now());`);
  return id;
}

function clearIpRate() {
  sql(`delete from verification_rate where scope = 'ip';`);
}

function clearEmailRate(email) {
  sql(`delete from verification_rate where scope = 'email' and scope_key = ${q(email)};`);
}

function count(table, where = '') {
  const v = sql(`select count(*) from ${table} ${where};`);
  return parseInt(v, 10);
}

function verificationState(email) {
  const rows = sqlRows(`select verified_at, code_provider from auth_verification where entity_id = ${q(email)} and deleted_at is null order by requested_at desc;`);
  return rows.length ? { verified_at: rows[0][0], code_provider: rows[0][1] } : null;
}

// ===================== RUN =====================
(async () => {
  console.log('=== PawShop Customer Auth C3 (P0 OTP fix) — loopback acceptance ===');
  console.log(`BASE=${BASE}  SCRATCH_DB=${SCRATCH_DB}  CAPTURE_DIR=${CAPTURE_DIR}`);
  console.log('');

  const uniqEmail = (tag) => `${tag}-${rnd()}@${TEST_DOMAIN}`;

  // ---- baseline snapshots ----
  const orderBefore = count('"order"');
  const itemBefore = count('order_item');

  // ============================================================
  // 01: request returns 201 and does NOT leak the code over HTTP
  // ============================================================
  {
    clearIpRate();
    const email = uniqEmail('c3req');
    const reg = await register(email);
    const req = await requestOtp(reg.token, email);
    const leaked = req.body && (req.body.code || (req.body.verification && req.body.verification.code));
    record('01 otp request 201 + code NOT leaked over HTTP', req.status === 201 && !leaked, `status=${req.status}, leaked=${!!leaked}`);
  }

  // ============================================================
  // 02: real E2E — request → capture 6-digit code → confirm same code → verified
  // ============================================================
  {
    clearIpRate();
    clearCaptureDir();
    const email = uniqEmail('c3e2e');
    const reg = await register(email);
    const { req, confirm, code } = await verifyReal(reg.token, email);
    const verified = confirm && confirm.status === 200 && confirm.body && confirm.body.verified_at;
    record('02 real E2E: capture 6-digit code → confirm → verified', req.status === 201 && verified && /^[0-9]{6}$/.test(code || ''),
      `req=${req.status} code=${code} confirm=${confirm && confirm.status} verified=${!!verified}`);
  }

  // ============================================================
  // 03: claim succeeds after a REAL confirm (no DB shortcut)
  // ============================================================
  {
    clearIpRate();
    clearCaptureDir();
    const email = uniqEmail('c3claim');
    seedGuest(email);
    const reg = await register(email);
    const { confirm } = await verifyReal(reg.token, email);
    const claim = await request('POST', '/store/customers', { token: reg.token, body: { email } });
    const flipped = claim.status === 200 && claim.body && claim.body.customer && claim.body.customer.has_account === true;
    record('03 claim succeeds after REAL confirm', confirm && confirm.status === 200 && flipped, `confirm=${confirm && confirm.status} claim=${claim.status} flipped=${flipped}`);
  }

  // ============================================================
  // 04: WRONG code → confirm fails, never verified
  // ============================================================
  {
    clearIpRate();
    clearCaptureDir();
    const email = uniqEmail('c3wrong');
    const reg = await register(email);
    await requestOtp(reg.token, email); // issue a real code (ignore it)
    // Submit a different 6-digit code.
    const wrong = await confirmOtp(reg.token, '000000');
    const state = verificationState(email);
    record('04 wrong code → confirm fails, not verified', wrong.status >= 400 && (!state || !state.verified_at || state.verified_at === '' || state.verified_at === 'null'),
      `confirm=${wrong.status}`);
  }

  // ============================================================
  // 05: wrong LENGTH (5 digits) → rejected, never verified
  // ============================================================
  {
    clearIpRate();
    clearCaptureDir();
    const email = uniqEmail('c3len');
    const reg = await register(email);
    await requestOtp(reg.token, email);
    const wrong = await confirmOtp(reg.token, '12345');
    record('05 wrong length (5 digits) → rejected', wrong.status >= 400, `confirm=${wrong.status}`);
  }

  // ============================================================
  // 06: NON-NUMERIC code → rejected
  // ============================================================
  {
    clearIpRate();
    clearCaptureDir();
    const email = uniqEmail('c3nan');
    const reg = await register(email);
    await requestOtp(reg.token, email);
    const wrong = await confirmOtp(reg.token, '12ab56');
    record('06 non-numeric code → rejected', wrong.status >= 400, `confirm=${wrong.status}`);
  }

  // ============================================================
  // 07: a code used once cannot be re-used (one-time)
  // ============================================================
  {
    clearIpRate();
    clearCaptureDir();
    const email = uniqEmail('c3once');
    const reg = await register(email);
    const { confirm, code } = await verifyReal(reg.token, email);
    const first = confirm && confirm.status === 200;
    // Re-submit the SAME code: it must now be rejected (already used).
    const replay = await confirmOtp(reg.token, code);
    record('07 code is one-time (replay rejected)', first && replay.status >= 400, `first=${confirm && confirm.status} replay=${replay.status}`);
  }

  // ============================================================
  // 08: resend invalidates the previous code (new code wins)
  // ============================================================
  {
    clearIpRate();
    clearCaptureDir();
    const email = uniqEmail('c3resend');
    const reg = await register(email);
    // First request + capture.
    await requestOtp(reg.token, email);
    let code1 = null;
    for (let i = 0; i < 20 && !code1; i++) { await new Promise((r) => setTimeout(r, 300)); code1 = readCapturedCode(email); }
    // Clear the per-email cooldown so a second request is allowed immediately.
    clearEmailRate(email);
    clearCaptureDir();
    // Second request (resend) — generates a NEW code and invalidates code1.
    await requestOtp(reg.token, email);
    let code2 = null;
    for (let i = 0; i < 20 && !code2; i++) { await new Promise((r) => setTimeout(r, 300)); code2 = readCapturedCode(email); }
    // The old code must now be rejected; the new code must confirm.
    const oldRejected = await confirmOtp(reg.token, code1);
    const newAccepted = code2 ? await confirmOtp(reg.token, code2) : { status: 0 };
    record('08 resend invalidates old code, new code confirms',
      !!code1 && !!code2 && code1 !== code2 && oldRejected.status >= 400 && newAccepted.status === 200,
      `old=${code1}→${oldRejected.status} new=${code2}→${newAccepted.status}`);
  }

  // ============================================================
  // 09: cooldown — immediate re-request is 429 (regression preserved)
  // ============================================================
  {
    clearIpRate();
    clearCaptureDir();
    const email = uniqEmail('c3cd');
    const reg = await register(email);
    const first = await requestOtp(reg.token, email);
    const second = await requestOtp(reg.token, email);
    record('09 cooldown: first request 201, immediate re-request 429', first.status === 201 && second.status === 429, `first=${first.status} second=${second.status}`);
  }

  // ============================================================
  // 10: concurrent confirm of the SAME code → only one succeeds
  // ============================================================
  {
    clearIpRate();
    clearCaptureDir();
    const email = uniqEmail('c3conc');
    const reg = await register(email);
    await requestOtp(reg.token, email);
    let code = null;
    for (let i = 0; i < 20 && !code; i++) { await new Promise((r) => setTimeout(r, 300)); code = readCapturedCode(email); }
    const [a, b] = await Promise.all([confirmOtp(reg.token, code), confirmOtp(reg.token, code)]);
    const okCount = [a, b].filter((r) => r.status === 200).length;
    record('10 concurrent confirm of same code → exactly one succeeds', code && okCount === 1, `a=${a.status} b=${b.status}`);
  }

  // ============================================================
  // 11: no duplicate customer on repeated claim
  // ============================================================
  {
    clearIpRate();
    clearCaptureDir();
    const email = uniqEmail('c3dup');
    const reg = await register(email);
    await verifyReal(reg.token, email);
    await request('POST', '/store/customers', { token: reg.token, body: { email } });
    const c1 = count('customer', `where email = ${q(email)} and deleted_at is null`);
    // Replay the same actorless token.
    await request('POST', '/store/customers', { token: reg.token, body: { email } });
    const c2 = count('customer', `where email = ${q(email)} and deleted_at is null`);
    record('11 no duplicate customer on repeated claim', c1 === 1 && c2 === 1, `count ${c1}→${c2}`);
  }

  // ============================================================
  // 12: order/item snapshot unchanged
  // ============================================================
  {
    const orderAfter = count('"order"');
    const itemAfter = count('order_item');
    record('12 order/item snapshot unchanged', orderAfter === orderBefore && itemAfter === itemBefore, `order ${orderBefore}→${orderAfter}, item ${itemBefore}→${itemAfter}`);
  }

  // ---- summary ----
  console.log('');
  const fails = results.filter((r) => !r.pass);
  console.log(`=== RESULT: ${results.length - fails.length}/${results.length} PASS ===`);
  if (fails.length) {
    console.log('FAILED ITEMS:');
    for (const f of fails) console.log(`  - ${f.name}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('HARNESS ERROR:', e);
  process.exit(2);
});
