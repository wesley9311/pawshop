const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLocalEnvironment, blockedPublicRoute } = require('../src/lib/local-policy.cjs');
const valid = () => ({ NODE_ENV: 'development', PAWSHOP_MODE: 'local-admin-only', DATABASE_URL: 'postgres://dev:fixture@127.0.0.1:54329/pawshop_dev', JWT_SECRET: 'a'.repeat(64), COOKIE_SECRET: 'b'.repeat(64) });

test('local configuration has no secret or database fallback', () => {
  assert.throws(() => validateLocalEnvironment({}));
  assert.equal(validateLocalEnvironment(valid()).http.adminCors, 'http://127.0.0.1:9000,http://localhost:9000');
  for (const mutation of [{ NODE_ENV: 'production' }, { PAWSHOP_MODE: 'live' }, { JWT_SECRET: 'supersecret' }, { COOKIE_SECRET: '' }, { DATABASE_URL: 'postgres://user:pass@public.example/store' }, { DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/production' }]) {
    assert.throws(() => validateLocalEnvironment({ ...valid(), ...mutation }));
  }
});

test('storefront and customer authentication routes are gated', () => {
  for (const path of ['/store', '/store/products', '/store/carts', '/store/customers', '/auth/customer/emailpass/register', '/auth/customer/emailpass/reset-password']) assert.equal(blockedPublicRoute(path), true);
  for (const path of ['/health', '/admin/products', '/auth/user/emailpass', '/app']) assert.equal(blockedPublicRoute(path), false);
});
