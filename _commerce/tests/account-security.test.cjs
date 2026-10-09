'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/api/store/customers/me/security/route.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const routeExports = {};
vm.runInNewContext(code, {
  exports: routeExports, process: { env: { PAWSHOP_MODE: 'production-storefront' } },
  require(name) {
    if (name === '@medusajs/framework/utils') return { Modules: { CUSTOMER: 'customer', AUTH: 'auth' } };
    if (name.endsWith('production-modes.cjs')) return { commerceIsOpen: mode => mode === 'production-storefront' };
    throw Error(`Unexpected import: ${name}`);
  },
});

function request({ passwordSet = false, emptyPasswordIdentity = false, verification = { success: true, authIdentity: { id: 'ai_1' } }, body = {}, actorId = 'cus_1' } = {}) {
  const calls = [];
  const providers = [{ provider: 'otp-email', entity_id: 'buyer@example.test' }];
  if (passwordSet) providers.push({ provider: 'emailpass', entity_id: 'buyer@example.test', provider_metadata: { password: 'hashed' } });
  if (emptyPasswordIdentity) providers.push({ provider: 'emailpass', entity_id: 'buyer@example.test', provider_metadata: {} });
  const auth = {
    retrieveAuthIdentity: async () => ({ id: 'ai_1', app_metadata: { customer_id: 'cus_1' }, provider_identities: providers }),
    authenticate: async (provider, data) => { calls.push({ kind: 'authenticate', provider, data }); return verification; },
    createProviderIdentities: async data => { calls.push({ kind: 'create', data }); },
    updateProvider: async (provider, data) => { calls.push({ kind: 'update', provider, data }); return { success: true, authIdentity: { id: 'ai_1' } }; },
  };
  const customer = { retrieveCustomer: async () => ({ email: 'buyer@example.test', has_account: true }) };
  const req = { body, auth_context: { actor_id: actorId, auth_identity_id: 'ai_1' }, scope: { resolve: key => key === 'auth' ? auth : customer } };
  const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  return { req, res, calls };
}

test('security status exposes booleans, never password metadata', async () => {
  const { req, res } = request({ passwordSet: true });
  await routeExports.GET(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { email_code_enabled: true, password_set: true });
});

test('setting a first password consumes OTP for the same auth identity before provider update', async () => {
  const { req, res, calls } = request({ body: { code: '123456', new_password: 'long-password-123' } });
  await routeExports.POST(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map(c => c.kind), ['authenticate', 'create', 'update']);
  assert.equal(calls[0].provider, 'otp-email');
  assert.equal(calls[1].data.auth_identity_id, 'ai_1');
  assert.equal(calls[2].provider, 'emailpass');
});

test('wrong or cross-identity OTP cannot create an emailpass identity', async () => {
  for (const verification of [{ success: false }, { success: true, authIdentity: { id: 'ai_other' } }]) {
    const { req, res, calls } = request({ verification, body: { code: '123456', new_password: 'long-password-123' } });
    await routeExports.POST(req, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(calls.map(c => c.kind), ['authenticate']);
  }
});

test('a retry uses an existing password identity left by an interrupted first save', async () => {
  const { req, res, calls } = request({ emptyPasswordIdentity: true, body: { code: '123456', new_password: 'long-password-123' } });
  await routeExports.POST(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.map(c => c.kind), ['authenticate', 'update']);
});

test('changing a password requires the current password on the same identity', async () => {
  const wrong = request({ passwordSet: true, verification: { success: false }, body: { current_password: 'wrong', new_password: 'long-password-123' } });
  await routeExports.POST(wrong.req, wrong.res);
  assert.equal(wrong.res.statusCode, 401);
  assert.equal(wrong.calls.some(c => c.kind === 'update'), false);

  const good = request({ passwordSet: true, body: { current_password: 'old-secret', new_password: 'long-password-123' } });
  await routeExports.POST(good.req, good.res);
  assert.equal(good.res.statusCode, 200);
  assert.deepEqual(good.calls.map(c => c.kind), ['authenticate', 'update']);
  assert.equal(good.calls[0].provider, 'emailpass');
});

test('actor mismatch and short password stop before authentication or writes', async () => {
  const mismatch = request({ actorId: 'cus_other', body: { code: '123456', new_password: 'long-password-123' } });
  await routeExports.POST(mismatch.req, mismatch.res);
  assert.equal(mismatch.res.statusCode, 401);
  assert.equal(mismatch.calls.length, 0);
  const short = request({ body: { code: '123456', new_password: 'short' } });
  await routeExports.POST(short.req, short.res);
  assert.equal(short.res.statusCode, 400);
  assert.equal(short.calls.length, 0);
});
