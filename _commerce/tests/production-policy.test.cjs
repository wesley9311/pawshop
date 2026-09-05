'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProductionEnvironment } = require('../src/lib/production-policy.cjs');
const { productionPort } = require('../scripts/production-runtime.cjs');
const valid = () => ({
  NODE_ENV: 'production', PAWSHOP_MODE: 'production-admin-only',
  DATABASE_URL: 'postgresql://pawshop:private@db.internal/pawshop?sslmode=require',
  REDIS_URL: 'rediss://pawshop:private@redis.internal:6380/0',
  JWT_SECRET: 'a'.repeat(64), COOKIE_SECRET: 'b'.repeat(64),
  STOREFRONT_ORIGIN: 'https://shop.example.com', ADMIN_ORIGIN: 'https://admin.example.com',
});
test('production config is explicit, encrypted, and separates admin from storefront', () => {
  const config = validateProductionEnvironment(valid());
  assert.equal(config.redisUrl, valid().REDIS_URL);
  assert.equal(config.http.adminCors, 'https://admin.example.com');
  assert.equal(config.http.storeCors, 'https://shop.example.com');
});
test('production config fails closed without exposing supplied values', () => {
  const mutations = [
    { NODE_ENV: 'development' }, { PAWSHOP_MODE: 'live' },
    { DATABASE_URL: 'postgresql://user:secret@127.0.0.1:54329/pawshop_dev' },
    { DATABASE_URL: 'postgresql://user:secret@127.3.2.1/pawshop?sslmode=require' },
    { DATABASE_URL: 'postgresql://user:secret@localhost./pawshop?sslmode=require' },
    { DATABASE_URL: 'postgresql://user:secret@[::1]/pawshop?sslmode=require' },
    { DATABASE_URL: 'postgresql://:secret@db.internal/pawshop?sslmode=require' },
    { DATABASE_URL: 'postgresql://user:secret@db.internal/?sslmode=require' },
    { DATABASE_URL: 'postgresql://user:secret@db.internal/pawshop' },
    { REDIS_URL: 'redis://user:secret@redis.internal/0' },
    { STOREFRONT_ORIGIN: 'http://shop.example.com' },
    { ADMIN_ORIGIN: 'https://admin.example.com/path' },
    { ADMIN_ORIGIN: 'https://shop.example.com' },
    { COOKIE_SECRET: 'a'.repeat(64) },
    { MEDUSA_WORKER_MODE: 'invalid' },
  ];
  for (const mutation of mutations) {
    const supplied = Object.values(mutation)[0];
    assert.throws(() => validateProductionEnvironment({ ...valid(), ...mutation }), error => {
      assert.equal(error.message.includes(supplied), false);
      return true;
    });
  }
});
test('production port is a bounded positional value', () => {
  assert.equal(productionPort(), '9000');
  assert.equal(productionPort('1024'), '1024');
  for (const value of ['0', '80', '65536', '-p', '9000.5', '']) assert.throws(() => productionPort(value), /PORT/);
});
