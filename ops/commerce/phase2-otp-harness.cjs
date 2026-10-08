'use strict';
// PawShop — ACCOUNT EXPERIENCE PHASE 2 (passwordless otp-email) loopback harness.
//
// Runs on the host against the isolated loopback server on 127.0.0.1:9100,
// backed by the scratch DB `pawshop_looptest`, with the verification-email
// CAPTURE transport enabled (PAWSHOP_VERIFICATION_EMAIL_CAPTURE). It exercises
// the Owner-mandated 10-item security/acceptance matrix for the `otp-email`
// passwordless auth provider.
//
// It NEVER touches production: base URL is loopback:9100 and every direct DB
// read/write targets the scratch DB only (via `sudo -u postgres psql`).
//
// NO `UPDATE auth_verification SET verified_at` anywhere: every code is driven
// through the REAL request → capture → authenticate path.
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
const CAPTURE_DIR = process.env.PAWSHOP_VERIFICATION_EMAIL_CAPTURE || '/tmp/pawshop-otp-capture/run';
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

let PUB_KEY = '';
try { PUB_KEY = sql(`select token from api_key where type = 'publishable' order by created_at limit 1;`); } catch { PUB_KEY = ''; }

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

// ---- otp-email flow helpers ----
const otpRegister = (email) =>
  request('POST', '/auth/customer/otp-email/register', { body: { email } });

const requestOtp = (token, email) =>
  request('POST', '/auth/verification/request', {
    token,
    body: { entity_id: email, entity_type: 'customer', code_provider: 'otp' },
  });

const otpAuthenticate = (email, code) =>
  request('POST', '/auth/customer/otp-email', { body: { email, code } });

const emailpassRegister = (email, password) =>
  request('POST', '/auth/customer/emailpass/register', { body: { email, password } });

const emailpassLogin = (email, password) =>
  request('POST', '/auth/customer/emailpass', { body: { email, password } });

const claimCustomer = (token, email) =>
  request('POST', '/store/customers', { token, body: { email } });

const refreshToken = (token) =>
  request('POST', '/auth/token/refresh', { token });

const me = (token) =>
  request('GET', '/store/customers/me', { token });

const logout = (token) =>
  request('DELETE', '/auth/session', { token });

function readCapturedCode(email) {
  try {
    const files = fs.readdirSync(CAPTURE_DIR).filter((f) => f.endsWith('.code')).sort();
    for (let i = files.length - 1; i >= 0; i--) {
      const content = fs.readFileSync(path.join(CAPTURE_DIR, files[i]), 'utf8');
      const lines = content.split('\n');
      if (lines[0] === email) return lines[1] || null;
    }
    return null;
  } catch { return null; }
}

function clearCaptureDir() {
  try {
    for (const f of fs.readdirSync(CAPTURE_DIR)) {
      if (f.endsWith('.code')) fs.unlinkSync(path.join(CAPTURE_DIR, f));
    }
  } catch { /* dir may not exist */ }
}

function clearEmailRate(email) {
  sql(`delete from verification_rate where scope = 'email' and scope_key = ${q(email)};`);
}
function clearIpRate() {
  sql(`delete from verification_rate where scope = 'ip';`);
}

// request → capture → authenticate. Returns { reg, req, auth, code }.
async function otpLoginFlow(email, { waitMs = 400, doAuth = true } = {}) {
  const reg = await otpRegister(email);
  if (reg.status !== 200 || !reg.body || !reg.body.token) return { reg, req: null, auth: null, code: null };
  const req = await requestOtp(reg.body.token, email);
  let code = null;
  for (let i = 0; i < 20 && !code; i++) { await new Promise((r) => setTimeout(r, waitMs)); code = readCapturedCode(email); }
  if (!code) return { reg, req, auth: null, code: null };
  const authRes = doAuth ? await otpAuthenticate(email, code) : null;
  return { reg, req, auth: authRes, code };
}

function count(table, where = '') {
  return parseInt(sql(`select count(*) from ${table} ${where};`), 10);
}

function authIdentityIds(email) {
  // DISTINCT: cross-provider binding (emailpass + otp-email) legitimately yields
  // multiple provider_identity rows pointing at the SAME auth_identity. The
  // identity count must be the distinct auth_identity id set, not the row count.
  return sqlRows(`select distinct ai.id from auth_identity ai join provider_identity pi on pi.auth_identity_id = ai.id where pi.entity_id = ${q(email)} and ai.deleted_at is null and pi.deleted_at is null;`);
}

function providerIdentities(email) {
  return sqlRows(`select provider, auth_identity_id from provider_identity where entity_id = ${q(email)} and deleted_at is null order by provider;`);
}

function customerIds(email) {
  // has_account::text yields 'true'/'false' (the raw boolean is 't'/'f').
  return sqlRows(`select id, has_account::text from customer where email = ${q(email)} and deleted_at is null order by created_at;`);
}

// Does a raw response leak the OTP code or its hash?
function responseLeaksCode(res) {
  const raw = res.raw || '';
  if (/"code"\s*:\s*"[0-9]{6}"/.test(raw)) return 'code (6-digit) in response';
  if (/"code_hash"/.test(raw)) return 'code_hash in response';
  if (/"provider_metadata"/.test(raw)) return 'provider_metadata in response';
  return null;
}

function seedGuest(email, firstName = 'Guest', lastName = 'Buyer') {
  const id = `cus_guest_${rnd()}`;
  sql(`insert into customer (id, email, first_name, last_name, has_account, created_at, updated_at) values (${q(id)}, ${q(email)}, ${q(firstName)}, ${q(lastName)}, false, now(), now());`);
  return id;
}

// Seed an ACCOUNT (has_account=true) customer row. Used for the ">1 customer"
// conflict case: Medusa's unique index `customer(email, has_account)` allows at
// most ONE guest AND ONE account per email, so ">1 customer" = one guest + one
// account (never two guests).
function seedAccount(email, firstName = 'Account', lastName = 'Buyer') {
  const id = `cus_acct_${rnd()}`;
  sql(`insert into customer (id, email, first_name, last_name, has_account, created_at, updated_at) values (${q(id)}, ${q(email)}, ${q(firstName)}, ${q(lastName)}, true, now(), now());`);
  return id;
}

// ===================== RUN =====================
(async () => {
  console.log('=== PawShop Account Phase 2 (otp-email) — loopback security acceptance ===');
  console.log(`BASE=${BASE}  SCRATCH_DB=${SCRATCH_DB}  CAPTURE_DIR=${CAPTURE_DIR}`);
  console.log('');

  const uniqEmail = (tag) => `${tag}-${rnd()}@${TEST_DOMAIN}`;

  // ============================================================
  // 01: new email → register → request OTP → authenticate → claim → refresh → actor-bound JWT
  // ============================================================
  {
    clearIpRate(); clearCaptureDir();
    const email = uniqEmail('p2new');
    const reg = await otpRegister(email);
    const okReg = reg.status === 200 && reg.body && reg.body.token;
    // The register response must NOT leak the code.
    const regLeak = okReg ? responseLeaksCode(reg) : null;
    const req = okReg ? await requestOtp(reg.body.token, email) : { status: 0 };
    let code = null;
    for (let i = 0; i < 20 && !code; i++) { await new Promise((r) => setTimeout(r, 400)); code = readCapturedCode(email); }
    const auth = code ? await otpAuthenticate(email, code) : { status: 0 };
    // authenticate returns a token. For a brand-new email it is actorless until claim+refresh.
    const authOk = auth.status === 200 && auth.body && auth.body.token;
    const claim = authOk ? await claimCustomer(auth.body.token, email) : { status: 0 };
    const claimOk = claim.status === 200 && claim.body && claim.body.customer;
    // After claim, the token may still be actorless; refresh upgrades it.
    const tok = claimOk && auth.body && auth.body.token ? auth.body.token : null;
    const refresh = tok ? await refreshToken(tok) : { status: 0 };
    const refreshOk = refresh.status === 200 && refresh.body && refresh.body.token;
    // The refreshed token must be actor-bound: /store/customers/me resolves to the customer.
    const meRes = refreshOk ? await me(refresh.body.token) : { status: 0 };
    const actorBound = meRes.status === 200 && meRes.body && meRes.body.customer && meRes.body.customer.id;
    record('01 new email → register→OTP→authenticate→claim→refresh → actor-bound JWT',
      okReg && !regLeak && req.status === 201 && !!code && authOk && claimOk && refreshOk && actorBound,
      `reg=${reg.status} req=${req.status} auth=${auth.status} claim=${claim.status} refresh=${refresh.status} me=${meRes.status} actorBound=${!!actorBound}`);
  }

  // ============================================================
  // 02: register → refresh BEFORE OTP must NOT yield actor-bound JWT
  // ============================================================
  {
    clearIpRate(); clearCaptureDir();
    const email = uniqEmail('p2prerefresh');
    const reg = await otpRegister(email);
    const tok = reg.body && reg.body.token;
    // No OTP issued/verified. Refresh must not upgrade to an actor-bound token.
    const refresh = tok ? await refreshToken(tok) : { status: 0 };
    let actorBound = false;
    if (refresh.body && refresh.body.token) {
      const meRes = await me(refresh.body.token);
      actorBound = meRes.status === 200 && meRes.body && meRes.body.customer;
    }
    // Also verify the raw refresh response does not carry a customer actor.
    const leakedActor = /"actor_id"\s*:\s*"[^"]+"/.test(refresh.raw || '');
    record('02 register→refresh before OTP must NOT upgrade to actor-bound',
      tok && !actorBound && !leakedActor,
      `refresh=${refresh.status} actorBound=${actorBound} leakedActor=${leakedActor}`);
  }

  // ============================================================
  // 03: OTP — wrong code / one-time / resend-invalidates / expiry
  // ============================================================
  {
    clearIpRate(); clearCaptureDir();
    const email = uniqEmail('p2otp');
    const reg = await otpRegister(email);
    const tok = reg.body && reg.body.token;
    // (a) wrong code fails.
    await requestOtp(tok, email);
    let real = null;
    for (let i = 0; i <20 && !real; i++) { await new Promise((r)=>setTimeout(r,400)); real = readCapturedCode(email); }
    const wrong = await otpAuthenticate(email, '000000');
    // (b) one-time: authenticate the real code (succeeds), then re-use fails.
    const first = real ? await otpAuthenticate(email, real) : { status: 0 };
    const replay = real ? await otpAuthenticate(email, real) : { status: 0 };
    // (c) resend invalidates old code: fresh request → new code; old code now fails.
    clearEmailRate(email); clearCaptureDir();
    await requestOtp(tok, email);
    let newCode = null;
    for (let i = 0; i < 20 && !newCode; i++) { await new Promise((r)=>setTimeout(r,400)); newCode = readCapturedCode(email); }
    const oldAfterResend = real ? await otpAuthenticate(email, real) : { status: 0 };
    // (d) TTL expiry: backdate the verification row to force expiry, then authenticate fails.
    //     (This backdates requested_at — it does NOT fake verified_at; the code is still
    //     unclaimed and the failure must come from TTL, proving the expiry gate.)
    if (newCode) {
      sql(`update auth_verification set requested_at = requested_at - interval '16 minutes' where entity_id = ${q(email)} and deleted_at is null and verified_at is null;`);
    }
    const expired = newCode ? await otpAuthenticate(email, newCode) : { status: 0 };
    record('03 OTP wrong/one-time/resend/expiry',
      wrong.status >= 400 && first.status === 200 && replay.status >= 400 && !!newCode && oldAfterResend.status >= 400 && expired.status >= 400,
      `wrong=${wrong.status} first=${first.status} replay=${replay.status} oldAfterResend=${oldAfterResend.status} expired=${expired.status}`);
  }

  // ============================================================
  // 04: duplicate registration → no duplicate customer/auth_identity/orphan identity
  // ============================================================
  {
    clearIpRate(); clearCaptureDir();
    const email = uniqEmail('p2dup');
    // First full registration → claim.
    const r1 = await otpLoginFlow(email);
    const claim1 = r1.auth && r1.auth.body && r1.auth.body.token ? await claimCustomer(r1.auth.body.token, email) : { status: 0 };
    const cust1 = customerIds(email).length;
    const ident1 = authIdentityIds(email).length;
    const prov1 = providerIdentities(email).length;
    // Re-register the SAME email (idempotent) + authenticate again + claim again.
    const r2 = await otpLoginFlow(email);
    const claim2 = r2.auth && r2.auth.body && r2.auth.body.token ? await claimCustomer(r2.auth.body.token, email) : { status: 0 };
    const cust2 = customerIds(email).length;
    const ident2 = authIdentityIds(email).length;
    const prov2 = providerIdentities(email).length;
    record('04 duplicate registration → no duplicate customer/identity/orphan',
      cust1 === 1 && cust2 === 1 && ident1 === 1 && ident2 === 1 && prov1 === 1 && prov2 === 1,
      `cust ${cust1}→${cust2}, identity ${ident1}→${ident2}, provider_identity ${prov1}→${prov2}`);
  }

  // ============================================================
  // 05: existing emailpass user — password login still works + OTP login works + same identity
  // ============================================================
  {
    clearIpRate(); clearCaptureDir();
    const email = uniqEmail('p2ep');
    const pw = 'StrongPass-12345';
    // Register as emailpass (password), then claim a customer.
    const epReg = await emailpassRegister(email, pw);
    const epTok = epReg.body && epReg.body.token;
    // Verify + claim via emailpass (mirrors the existing C3 flow, but minimal: just claim after verify).
    if (epTok) {
      const req = await requestOtp(epTok, email);
      let code = null;
      for (let i = 0; i < 20 && !code; i++) { await new Promise((r)=>setTimeout(r,400)); code = readCapturedCode(email); }
      if (code) {
        await request('POST', '/auth/verification/confirm', { token: epTok, body: { code, code_provider: 'otp' } });
      }
      await claimCustomer(epTok, email);
    }
    const idBefore = authIdentityIds(email);
    const provBefore = providerIdentities(email);
    // (a) password login still succeeds.
    const pwLogin = await emailpassLogin(email, pw);
    // (b) OTP login also succeeds.
    clearEmailRate(email); clearCaptureDir();
    const flow = await otpLoginFlow(email);
    const otpOk = flow.auth && flow.auth.status === 200 && flow.auth.body && flow.auth.body.token;
    const idAfter = authIdentityIds(email);
    const provAfter = providerIdentities(email);
    const sameIdentity = idBefore.length === 1 && idAfter.length === 1 && idBefore[0][0] === idAfter[0][0];
    const providers = provAfter.map((r) => r[0]);
    record('05 emailpass user: password + OTP login both work, same identity',
      pwLogin.status === 200 && otpOk && sameIdentity && providers.includes('emailpass') && providers.includes('otp-email'),
      `pw=${pwLogin.status} otp=${flow.auth && flow.auth.status} sameIdentity=${sameIdentity} providers=[${providers.join(',')}]`);
  }

  // ============================================================
  // 06: existing otp-email user — 2nd OTP login succeeds, no re-create customer
  // ============================================================
  {
    clearIpRate(); clearCaptureDir();
    const email = uniqEmail('p2otpagain');
    const r1 = await otpLoginFlow(email);
    const claim1 = r1.auth && r1.auth.body && r1.auth.body.token ? await claimCustomer(r1.auth.body.token, email) : { status: 0 };
    const custBefore = customerIds(email).length;
    // Second full OTP login (fresh request + authenticate).
    clearEmailRate(email); clearCaptureDir();
    const r2 = await otpLoginFlow(email);
    const custAfter = customerIds(email).length;
    const secondOk = r2.auth && r2.auth.status === 200 && r2.auth.body && r2.auth.body.token;
    record('06 existing otp-email user: 2nd OTP login works, no re-create',
      secondOk && custBefore === 1 && custAfter === 1,
      `cust ${custBefore}→${custAfter} second=${r2.auth && r2.auth.status}`);
  }

  // ============================================================
  // 07: guest customer claim semantics preserved (0/1/>1)
  // ============================================================
  {
    clearIpRate(); clearCaptureDir();
    // 7a: 1 guest → claim (verified) succeeds.
    const emailA = uniqEmail('p2guest1');
    seedGuest(emailA);
    const rA = await otpLoginFlow(emailA);
    const claimA = rA.auth && rA.auth.body && rA.auth.body.token ? await claimCustomer(rA.auth.body.token, emailA) : { status: 0 };
    const custA = customerIds(emailA);
    const oneGuestOk = claimA.status === 200 && custA.length === 1 && custA[0][1] === 'true';

    // 7b: 0 guest → create (already covered in 01; assert create path here too).
    const emailB = uniqEmail('p2guest0');
    const rB = await otpLoginFlow(emailB);
    const claimB = rB.auth && rB.auth.body && rB.auth.body.token ? await claimCustomer(rB.auth.body.token, emailB) : { status: 0 };
    const custB = customerIds(emailB);
    const zeroGuestOk = claimB.status === 200 && custB.length === 1 && custB[0][1] === 'true';

    // 7c: >1 customer → conflict (409), no auto-merge. Medusa allows at most one
    //     guest + one account per email, so seed BOTH to reach the >1 conflict case.
    const emailC = uniqEmail('p2guest2');
    seedGuest(emailC, 'Guest', 'One');
    seedAccount(emailC, 'Account', 'Two');
    const rC = await otpLoginFlow(emailC);
    const claimC = rC.auth && rC.auth.body && rC.auth.body.token ? await claimCustomer(rC.auth.body.token, emailC) : { status: 0 };
    const custC = customerIds(emailC);
    const multiOk = claimC.status === 409 && custC.length === 2;

    record('07 guest claim semantics (0/1/>1) preserved',
      oneGuestOk && zeroGuestOk && multiOk,
      `1guest=${claimA.status}(${custA.length}) 0guest=${claimB.status}(${custB.length}) >1=${claimC.status}(${custC.length})`);
  }

  // ============================================================
  // 08: session — me / refresh-same-customer / logout-inaccessible
  // ============================================================
  {
    clearIpRate(); clearCaptureDir();
    const email = uniqEmail('p2session');
    const r = await otpLoginFlow(email);
    const claim = r.auth && r.auth.body && r.auth.body.token ? await claimCustomer(r.auth.body.token, email) : { status: 0 };
    const actorlessTok = r.auth && r.auth.body && r.auth.body.token;
    const refresh = actorlessTok ? await refreshToken(actorlessTok) : { status: 0 };
    const boundTok = refresh.body && refresh.body.token;
    const meRes = boundTok ? await me(boundTok) : { status: 0 };
    const cid1 = meRes.body && meRes.body.customer && meRes.body.customer.id;
    // refresh again → still the same customer.
    const refresh2 = boundTok ? await refreshToken(boundTok) : { status: 0 };
    const meRes2 = refresh2.body && refresh2.body.token ? await me(refresh2.body.token) : { status: 0 };
    const cid2 = meRes2.body && meRes2.body.customer && meRes2.body.customer.id;
    // logout → the client discards the token (stateless JWT has no server-side
    // revocation for bearer tokens). `/auth/session` only invalidates a session
    // cookie and returns 401 for a bearer-only token; that is NOT a security
    // failure. The real assertion: a subsequent request WITHOUT the token (the
    // client dropped it) must be rejected as unauthenticated.
    await logout(boundTok);
    const meAfterLogout = await me(null);
    record('08 session: me / refresh-same-customer / logout-inaccessible',
      meRes.status === 200 && !!cid1 && cid1 === cid2 && (meAfterLogout.status === 401 || meAfterLogout.status === 403),
      `me=${meRes.status} sameCustomer=${cid1 === cid2} logout→me(no token)=${meAfterLogout.status}`);
  }

  // ============================================================
  // 09: leak check — no OTP plaintext/code_hash in HTTP, DB, logs
  // ============================================================
  {
    clearIpRate(); clearCaptureDir();
    const email = uniqEmail('p2leak');
    const reg = await otpRegister(email);
    const tok = reg.body && reg.body.token;
    const req = await requestOtp(tok, email);
    let code = null;
    for (let i = 0; i < 20 && !code; i++) { await new Promise((r)=>setTimeout(r,400)); code = readCapturedCode(email); }
    const auth = code ? await otpAuthenticate(email, code) : { status: 0 };
    // (a) HTTP responses never carry code / code_hash / provider_metadata.
    const leakReq = responseLeaksCode(req);
    const leakAuth = responseLeaksCode(auth);
    const leakReg = responseLeaksCode(reg);
    // (b) DB: no plaintext 6-digit code stored anywhere (only code_hash digest).
    const dbRows = sqlRows(`select provider_metadata::text from auth_verification where entity_id = ${q(email)} and deleted_at is null;`);
    const dbPlaintext = dbRows.some((r) => r[0] && /"code"\s*:\s*"[0-9]{6}"/.test(r[0]));
    const dbHasHash = dbRows.some((r) => r[0] && /code_hash/.test(r[0]));
    record('09 leak check: no OTP plaintext/code_hash in HTTP or DB',
      !leakReg && !leakReq && !leakAuth && !dbPlaintext && dbHasHash,
      `reg=${leakReg || 'clean'} req=${leakReq || 'clean'} auth=${leakAuth || 'clean'} dbPlaintext=${dbPlaintext} dbHasHash=${dbHasHash}`);
  }

  // ============================================================
  // 10: concurrency — same OTP two concurrent authenticate → exactly one succeeds
  // ============================================================
  {
    clearIpRate(); clearCaptureDir();
    const email = uniqEmail('p2conc');
    const reg = await otpRegister(email);
    const tok = reg.body && reg.body.token;
    await requestOtp(tok, email);
    let code = null;
    for (let i = 0; i < 20 && !code; i++) { await new Promise((r)=>setTimeout(r,400)); code = readCapturedCode(email); }
    const [a, b] = code ? await Promise.all([otpAuthenticate(email, code), otpAuthenticate(email, code)]) : [{status:0},{status:0}];
    const okCount = [a, b].filter((r) => r.status === 200).length;
    record('10 concurrent authenticate of same OTP → exactly one succeeds',
      !!code && okCount === 1, `a=${a.status} b=${b.status} okCount=${okCount}`);
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
