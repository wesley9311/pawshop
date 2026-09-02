'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { constrainedBackupPath, equalHex } = require('../scripts/backup-integrity.cjs');

const root = resolve(__dirname, '..');
const backup = readFileSync(resolve(root, 'scripts/backup-real.mjs'), 'utf8');
const restore = readFileSync(resolve(root, 'scripts/restore-verify-real.mjs'), 'utf8');
const runtime = readFileSync(resolve(root, 'scripts/private-runtime.cjs'), 'utf8');

test('real backup is encrypted and plaintext is removed', () => {
  assert.match(backup, /aes-256-cbc/);
  assert.match(backup, /-pbkdf2/);
  assert.match(backup, /rmSync\(plainTemp/);
  assert.match(backup, /hmac_sha256/);
  assert.match(backup, /atomicPrivateWrite/);
  assert.doesNotMatch(backup, /customers:\s*0|orders:\s*0|Expected one approved source product/);
  assert.doesNotMatch(backup, /criticalDataSha256|SELECT count\(\*\)/);
});

test('real restore authenticates paths and cleans the temporary database', () => {
  assert.match(restore, /constrainedBackupPath/);
  assert.match(restore, /hmac_sha256/);
  assert.match(restore, /dropdb/);
  assert.match(restore, /PAWSHOP_KEEP_RESTORE_DB/);
  assert.match(restore, /pawshop-real-restore-verification-v2/);
  assert.match(restore, /critical_data_sha256/);
  assert.match(restore, /AggregateError/);
  assert.ok(restore.indexOf('dropdb') < restore.indexOf('writeFileSync(verificationTemporary'));
});

test('backup key loss cannot silently replace a key for existing backups', () => {
  assert.match(runtime, /hasEncryptedBackups/);
  assert.match(runtime, /Existing backups must not be overwritten with a new key/);
  assert.doesNotMatch(runtime, /if \(!existsSync\(backupKeyFile\)\) secureWrite/);
});

test('backup path and digest comparisons reject unsafe values', () => {
  assert.equal(constrainedBackupPath('/private/backups', '/private/backups/a.enc', 'backup'), '/private/backups/a.enc');
  assert.throws(() => constrainedBackupPath('/private/backups', '/private/escape.enc', 'backup'));
  assert.equal(equalHex('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(equalHex('a'.repeat(64), 'b'.repeat(64)), false);
  assert.equal(equalHex('invalid', 'invalid'), false);
});
