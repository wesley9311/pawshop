'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProductionEnvironment } = require('../src/lib/production-policy.cjs');
const { productionPort } = require('../scripts/production-runtime.cjs');
const valid = () => ({
  NODE_ENV: 'production', PAWSHOP_MODE: 'production-admin-only',
  PAWSHOP_INFRA_TOPOLOGY: 'managed-tls', PAWSHOP_MANAGED_NETWORK_ATTESTED: '1',
  DATABASE_URL: 'postgresql://pawshop:private@db.internal/pawshop?sslmode=require',
  REDIS_URL: 'rediss://pawshop:private@redis.internal:6380/0',
  JWT_SECRET: 'a'.repeat(64), COOKIE_SECRET: 'b'.repeat(64),
  STOREFRONT_ORIGIN: 'https://shop.example.com', ADMIN_ORIGIN: 'https://admin.example.com',
  S3_FILE_URL: 'https://media.example.com/pawshop',
  S3_ACCESS_KEY_ID: 'fixture-access-key', S3_SECRET_ACCESS_KEY: 'fixture-secret-value',
  S3_REGION: 'us-east-1', S3_BUCKET: 'pawshop-media', S3_ENDPOINT: 'https://s3.example.com',
  S3_DISABLE_ACL: '1',
});
test('production config is explicit, encrypted, and separates admin from storefront', () => {
  const config = validateProductionEnvironment(valid());
  assert.equal(config.redisUrl, valid().REDIS_URL);
  assert.equal(config.http.adminCors, 'https://admin.example.com');
  assert.equal(config.http.storeCors, 'https://shop.example.com');
  assert.equal(config.fileStorage.prefix, 'products/');
  assert.equal(config.fileStorage.acl, false);
});
test('single-host production is private, authenticated, and tunnel-only', () => {
  const config = validateProductionEnvironment({
    ...valid(),
    PAWSHOP_INFRA_TOPOLOGY: 'single-host-private',
    DATABASE_URL: 'postgresql://pawshop:private@127.0.0.1:5432/pawshop?sslmode=disable',
    REDIS_URL: 'redis://pawshop:private@127.0.0.1:6379/0',
    ADMIN_ORIGIN: 'http://127.0.0.1:9000',
  });
  assert.equal(config.topology, 'single-host-private');
  assert.equal(config.http.adminCors, 'http://127.0.0.1:9000');
});
test('production config fails closed without exposing supplied values', () => {
  const mutations = [
    { NODE_ENV: 'development' }, { PAWSHOP_MODE: 'live' },
    { PAWSHOP_INFRA_TOPOLOGY: 'public-single-host' },
    { PAWSHOP_MANAGED_NETWORK_ATTESTED: '0' },
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
    { S3_FILE_URL: 'http://media.example.com/pawshop' },
    { S3_ENDPOINT: 'https://user:secret@s3.example.com' },
    { S3_ACCESS_KEY_ID: '/bad' },
    { S3_SECRET_ACCESS_KEY: 'short' },
    { S3_BUCKET: '../escape' },
    { S3_FORCE_PATH_STYLE: 'yes' },
    { S3_DISABLE_ACL: '0' },
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
test('single-host topology rejects public services and public admin origins', () => {
  const local = {
    ...valid(),
    PAWSHOP_INFRA_TOPOLOGY: 'single-host-private',
    DATABASE_URL: 'postgresql://pawshop:private@127.0.0.1:5432/pawshop?sslmode=disable',
    REDIS_URL: 'redis://pawshop:private@127.0.0.1:6379/0',
    ADMIN_ORIGIN: 'http://127.0.0.1:9000',
  };
  for (const mutation of [
    { DATABASE_URL: 'postgresql://pawshop:private@db.example.com/pawshop?sslmode=disable' },
    { DATABASE_URL: 'postgresql://pawshop:private@127.0.0.1:5433/pawshop?sslmode=disable' },
    { DATABASE_URL: 'postgresql://pawshop:private@127.0.0.1:5432/pawshop?sslmode=require' },
    { REDIS_URL: 'redis://pawshop:private@redis.example.com:6379/0' },
    { REDIS_URL: 'redis://pawshop:private@127.0.0.1:6380/0' },
    { ADMIN_ORIGIN: 'https://admin.example.com' },
    { ADMIN_ORIGIN: 'http://localhost:9000' },
    { MEDUSA_WORKER_MODE: 'server' },
    { MEDUSA_WORKER_MODE: 'worker' },
  ]) assert.throws(() => validateProductionEnvironment({ ...local, ...mutation }));
});
test('production port is a bounded positional value', () => {
  assert.equal(productionPort(), '9000');
  assert.equal(productionPort('1024'), '1024');
  for (const value of ['0', '80', '65536', '-p', '9000.5', '']) assert.throws(() => productionPort(value), /PORT/);
});
