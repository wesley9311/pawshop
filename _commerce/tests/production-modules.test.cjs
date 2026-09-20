'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { productionModules } = require('../src/lib/production-modules.cjs');

test('production uses Redis for cache, events, workflows, and locks', () => {
  const redisUrl = 'rediss://user:secret@redis.internal:6380/0';
  const fileStorage = {
    file_url: 'https://media.example.com', access_key_id: 'fixture-access',
    secret_access_key: 'fixture-secret-value', region: 'auto', bucket: 'pawshop-media',
    endpoint: 'https://s3.example.com', prefix: 'products/',
  };
  const modules = productionModules({ redisUrl, fileStorage });
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
  // Without Google credentials the auth module registers emailpass alone — the
  // exact provider set current production already has.
  assert.deepEqual(modules[5].options.providers.map(p => p.id), ['emailpass']);
  assert.throws(() => productionModules({ redisUrl: '', fileStorage }), /validated Redis URL/);
  assert.throws(() => productionModules({ redisUrl, fileStorage: {} }), /object storage/);
});

test('the auth module adds google only when the full credential triple is present', () => {
  const redisUrl = 'rediss://user:secret@redis.internal:6380/0';
  const fileStorage = {
    file_url: 'https://media.example.com', access_key_id: 'fixture-access',
    secret_access_key: 'fixture-secret-value', region: 'auto', bucket: 'pawshop-media',
    endpoint: 'https://s3.example.com', prefix: 'products/',
  };
  const auth = (googleAuth) => productionModules({ redisUrl, fileStorage, googleAuth })
    .find(m => m.resolve === '@medusajs/medusa/auth');

  // Absent / null / empty triple -> emailpass only.
  assert.deepEqual(auth(undefined).options.providers.map(p => p.id), ['emailpass']);
  assert.deepEqual(auth(null).options.providers.map(p => p.id), ['emailpass']);
  assert.deepEqual(auth({}).options.providers.map(p => p.id), ['emailpass']);

  // Full triple -> emailpass + google, google carries its resolved options.
  const googleAuth = {
    clientId: '1234-abc.apps.googleusercontent.com',
    clientSecret: 'a'.repeat(24),
    callbackUrl: 'https://pawlivora.com/app/login',
  };
  const withGoogle = auth(googleAuth).options.providers;
  assert.deepEqual(withGoogle.map(p => p.id), ['emailpass', 'google']);
  const google = withGoogle.find(p => p.id === 'google');
  assert.deepEqual(google.options, googleAuth);
});
