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
  ]);
  assert.equal(modules[0].options.providers[0].options, fileStorage);
  assert.equal(modules[1].options.providers[0].options.redisUrl, redisUrl);
  assert.equal(modules[2].options.redisUrl, redisUrl);
  assert.equal(modules[3].options.redis.redisUrl, redisUrl);
  assert.equal(modules[4].options.providers[0].options.redisUrl, redisUrl);
  assert.throws(() => productionModules({ redisUrl: '', fileStorage }), /validated Redis URL/);
  assert.throws(() => productionModules({ redisUrl, fileStorage: {} }), /object storage/);
});
