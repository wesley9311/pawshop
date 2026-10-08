'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { productionModules } = require('../src/lib/production-modules.cjs');

const JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('production uses Redis for cache, events, workflows, and locks', () => {
  const redisUrl = 'rediss://user:secret@redis.internal:6380/0';
  const fileStorage = {
    file_url: 'https://media.example.com', access_key_id: 'fixture-access',
    secret_access_key: 'fixture-secret-value', region: 'auto', bucket: 'pawshop-media',
    endpoint: 'https://s3.example.com', prefix: 'products/',
  };
  const modules = productionModules({ redisUrl, fileStorage, jwtSecret: JWT_SECRET });
  assert.deepEqual(modules.map(module => module.resolve), [
    '@medusajs/medusa/file',
    '@medusajs/medusa/caching',
    '@medusajs/medusa/event-bus-redis',
    '@medusajs/medusa/workflow-engine-redis',
    '@medusajs/medusa/locking',
    '@medusajs/medusa/auth',
  ]);
  assert.equal(modules[0].options.providers[0].options, fileStorage);
  assert.equal(modules[1].options.providers[0].options.redisUrl, redisUrl);
  assert.equal(modules[2].options.redisUrl, redisUrl);
  assert.equal(modules[3].options.redis.redisUrl, redisUrl);
  assert.equal(modules[4].options.providers[0].options.redisUrl, redisUrl);
  // Without Google credentials the auth module registers emailpass + otp-email.
  // `otp-email` is the passwordless one-time-code provider added in Account
  // Phase 2; it is always registered alongside emailpass (no credential gate —
  // its HMAC key derives from the validated JWT_SECRET).
  assert.deepEqual(modules[5].options.providers.map(p => p.id), ['emailpass', 'otp-email']);
  assert.equal(modules[5].options.providers[1].resolve, './src/modules/pawshop-otp-email-auth');
  assert.deepEqual(modules[5].options.providers[1].options, { hmac_secret: JWT_SECRET });
  assert.throws(() => productionModules({ redisUrl: '', fileStorage, jwtSecret: JWT_SECRET }), /validated Redis URL/);
  assert.throws(() => productionModules({ redisUrl, fileStorage: {}, jwtSecret: JWT_SECRET }), /object storage/);
  assert.throws(() => productionModules({ redisUrl, fileStorage }), /JWT secret/);
});

test('the auth module adds google only when the full credential triple is present', () => {
  const redisUrl = 'rediss://user:secret@redis.internal:6380/0';
  const fileStorage = {
    file_url: 'https://media.example.com', access_key_id: 'fixture-access',
    secret_access_key: 'fixture-secret-value', region: 'auto', bucket: 'pawshop-media',
    endpoint: 'https://s3.example.com', prefix: 'products/',
  };
  const auth = (googleAuth) => productionModules({ redisUrl, fileStorage, googleAuth, jwtSecret: JWT_SECRET })
    .find(m => m.resolve === '@medusajs/medusa/auth');

  // Absent / null / empty triple -> emailpass + otp-email (no google).
  assert.deepEqual(auth(undefined).options.providers.map(p => p.id), ['emailpass', 'otp-email']);
  assert.deepEqual(auth(null).options.providers.map(p => p.id), ['emailpass', 'otp-email']);
  assert.deepEqual(auth({}).options.providers.map(p => p.id), ['emailpass', 'otp-email']);

  // Full triple -> emailpass + otp-email + google, google carries its resolved options.
  const googleAuth = {
    clientId: '1234-abc.apps.googleusercontent.com',
    clientSecret: 'a'.repeat(24),
    callbackUrl: 'https://pawlivora.com/app/login',
  };
  const withGoogle = auth(googleAuth).options.providers;
  assert.deepEqual(withGoogle.map(p => p.id), ['emailpass', 'otp-email', 'google']);
  const google = withGoogle.find(p => p.id === 'google');
  assert.deepEqual(google.options, googleAuth);
});

test('the payment module (and PayPal provider) is registered only when credentials are present', () => {
  const redisUrl = 'rediss://user:secret@redis.internal:6380/0';
  const fileStorage = {
    file_url: 'https://media.example.com', access_key_id: 'fixture-access',
    secret_access_key: 'fixture-secret-value', region: 'auto', bucket: 'pawshop-media',
    endpoint: 'https://s3.example.com', prefix: 'products/',
  };
  const payment = (paypal) => productionModules({ redisUrl, fileStorage, paypal, jwtSecret: JWT_SECRET })
    .find(m => m.resolve === '@medusajs/medusa/payment');

  // Absent / null -> no payment module: the framework default (system provider
  // alone) stays in place and nothing money-capable is exposed.
  assert.equal(payment(undefined), undefined);
  assert.equal(payment(null), undefined);

  // Full PayPal config -> payment module registered with exactly the PayPal
  // provider, and the system provider is NOT listed (it must never reach a
  // customer-facing region).
  const paypal = {
    client_id: 'fixture-client-id',
    client_secret: 'fixture-client-secret',
    sandbox: true,
    webhook_id: 'WH-1234567890',
    return_url: 'https://pawlivora.com/order/complete',
    cancel_url: 'https://pawlivora.com/checkout',
  };
  const withPaypal = payment(paypal);
  assert.ok(withPaypal, 'payment module registered when PayPal is configured');
  assert.equal(withPaypal.options.providers.length, 1);
  const provider = withPaypal.options.providers[0];
  assert.equal(provider.id, 'paypal');
  assert.equal(provider.resolve, './src/modules/paypal');
  assert.deepEqual(provider.options, paypal);
});
