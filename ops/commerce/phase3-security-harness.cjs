'use strict';
// Run only against the isolated 127.0.0.1:9100 scratch server and pawshop_looptest.
// Codes are read from the test-only capture transport; no production customer is
// created, and no verification row is edited to bypass the real OTP flow.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const BASE = 'http://127.0.0.1:9100';
const CAPTURE = '/tmp/pawshop-otp-capture/run';
const sql = query => execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'pawshop_looptest', '-tA', '-c', query], { encoding: 'utf8' }).trim();
const q = value => `'${String(value).replace(/'/g, "''")}'`;
const key = sql("select token from api_key where type = 'publishable' and revoked_at is null order by created_at limit 1");
if (!key) throw Error('Scratch publishable key missing.');

async function request(method, endpoint, { token, body } = {}) {
  const data = body == null ? null : JSON.stringify(body);
  return new Promise(resolve => {
    const req = http.request(BASE + endpoint, {
      method,
      headers: {
        accept: 'application/json',
        ...(endpoint.startsWith('/store') ? { 'x-publishable-api-key': key } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', part => { raw += part; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', error => resolve({ status: 0, error: String(error) }));
    if (data) req.write(data);
    req.end();
  });
}

function capturedCode(email) {
  if (!fs.existsSync(CAPTURE)) return null;
  for (const name of fs.readdirSync(CAPTURE).filter(name => name.endsWith('.code')).sort().reverse()) {
    const [to, code] = fs.readFileSync(path.join(CAPTURE, name), 'utf8').split('\n');
    if (to === email && /^[0-9]{6}$/.test(code)) return code;
  }
  return null;
}

async function sendCode(email) {
  const before = capturedCode(email);
  const registration = await request('POST', '/auth/customer/otp-email/register', { body: { email } });
  check('OTP registration', registration.status === 200 && !!registration.body?.token);
  const send = () => request('POST', '/auth/verification/request', {
    token: registration.body.token,
    body: { entity_id: email, entity_type: 'customer', code_provider: 'otp' },
  });
  let sent = await send();
  if (sent.status === 429) {
    console.log('WAIT OTP resend cooldown (62s)');
    await new Promise(resolve => setTimeout(resolve, 62000));
    sent = await send();
  }
  check('OTP request', sent.status === 201);
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = capturedCode(email);
    if (code && code !== before) return code;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Capture transport did not record a fresh code.');
}

function check(name, success) {
  console.log(`${success ? 'PASS' : 'FAIL'} ${name}`);
  if (!success) throw Error(name);
}

async function run() {
  const email = `phase3-${crypto.randomBytes(6).toString('hex')}@loopback.test`;
  const firstPassword = `P3-first-${crypto.randomBytes(12).toString('hex')}`;
  const secondPassword = `P3-next-${crypto.randomBytes(12).toString('hex')}`;
  const health = await request('GET', '/health');
  check('isolated server healthy', health.status === 200);

  const loginCode = await sendCode(email);
  const otpLogin = await request('POST', '/auth/customer/otp-email', { body: { email, code: loginCode } });
  check('OTP sign-in', otpLogin.status === 200 && !!otpLogin.body?.token);
  const claim = await request('POST', '/store/customers', { token: otpLogin.body.token, body: { email } });
  check('scratch customer claim', claim.status === 200 && !!claim.body?.customer?.id);
  const refreshed = await request('POST', '/auth/token/refresh', { token: otpLogin.body.token });
  check('actor-bound refresh', refreshed.status === 200 && !!refreshed.body?.token);
  const token = refreshed.body.token;
  const me = await request('GET', '/store/customers/me', { token });
  check('me resolves scratch customer', me.status === 200 && me.body?.customer?.id === claim.body.customer.id);

  const initial = await request('GET', '/store/customers/me/security', { token });
  check('OTP-only password status', initial.status === 200 && initial.body?.password_set === false && initial.body?.email_code_enabled === true);
  const rejected = await request('POST', '/store/customers/me/security', { token, body: { code: '000000', new_password: firstPassword } });
  check('invalid code rejected', rejected.status === 401);
  const stillUnset = await request('GET', '/store/customers/me/security', { token });
  check('invalid code made no password', stillUnset.status === 200 && stillUnset.body?.password_set === false);

  const setCode = await sendCode(email);
  const set = await request('POST', '/store/customers/me/security', { token, body: { code: setCode, new_password: firstPassword } });
  check('OTP-verified first password saved', set.status === 200 && set.body?.password_set === true);
  const replay = await request('POST', '/store/customers/me/security', { token, body: { code: setCode, new_password: secondPassword } });
  check('used OTP cannot change password', replay.status !== 200);
  const status = await request('GET', '/store/customers/me/security', { token });
  check('password now set', status.status === 200 && status.body?.password_set === true);
  const firstLogin = await request('POST', '/auth/customer/emailpass', { body: { email, password: firstPassword } });
  check('new password logs in', firstLogin.status === 200 && !!firstLogin.body?.token);

  const wrongCurrent = await request('POST', '/store/customers/me/security', { token, body: { current_password: 'wrong', new_password: secondPassword } });
  check('wrong current password rejected', wrongCurrent.status === 401);
  const changed = await request('POST', '/store/customers/me/security', { token, body: { current_password: firstPassword, new_password: secondPassword } });
  check('correct current password changes password', changed.status === 200);
  const oldLogin = await request('POST', '/auth/customer/emailpass', { body: { email, password: firstPassword } });
  const newLogin = await request('POST', '/auth/customer/emailpass', { body: { email, password: secondPassword } });
  check('old password stops working', oldLogin.status === 401);
  check('new password logs in', newLogin.status === 200 && !!newLogin.body?.token);

  const identityCount = sql(`select count(distinct ai.id) from auth_identity ai join provider_identity pi on pi.auth_identity_id=ai.id where pi.entity_id=${q(email)} and pi.deleted_at is null`);
  const customerCount = sql(`select count(*) from customer where email=${q(email)} and deleted_at is null`);
  check('one identity and one customer', identityCount === '1' && customerCount === '1');
  const noTokenMe = await request('GET', '/store/customers/me');
  check('signed-out me inaccessible', noTokenMe.status === 401 || noTokenMe.status === 403);
  console.log('PHASE 3 SCRATCH FLOW PASS');
}

run().catch(error => { console.error('PHASE 3 SCRATCH FLOW FAIL:', error.message); process.exitCode = 1; });
