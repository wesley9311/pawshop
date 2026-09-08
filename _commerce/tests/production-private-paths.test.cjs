'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertBackupArtifactStat,
  assertBackupDirectoryStat,
  assertBackupKeyStat,
  databaseConnection,
  productionPrivatePaths,
} = require('../scripts/production-private-paths.cjs');

test('production backup locations cannot drift into public or release paths', () => {
  assert.deepEqual(productionPrivatePaths({
    PAWSHOP_BACKUP_DIR: '/var/backups/pawshop',
    PAWSHOP_BACKUP_KEY_FILE: '/etc/pawshop/backup.key',
  }), {
    backupDir: '/var/backups/pawshop', backupKeyFile: '/etc/pawshop/backup.key',
  });
  assert.throws(() => productionPrivatePaths({
    PAWSHOP_BACKUP_DIR: '/srv/pawshop/current/backups',
    PAWSHOP_BACKUP_KEY_FILE: '/etc/pawshop/backup.key',
  }), /approved private Ubuntu locations/);
});

test('production backup parses only the fixed authenticated PostgreSQL endpoint', () => {
  assert.deepEqual(databaseConnection('postgresql://pawshop:s%40fe@127.0.0.1:5432/pawshop?sslmode=disable'), {
    host: '127.0.0.1', port: '5432', user: 'pawshop', password: 's@fe', database: 'pawshop',
  });
  for (const url of [
    'postgresql://pawshop:secret@db.example.com/pawshop',
    'postgresql://pawshop:secret@127.0.0.1:5433/pawshop',
    'postgresql://pawshop@127.0.0.1:5432/pawshop',
    'postgresql://pawshop:secret@127.0.0.1:5432/pawshop-production',
  ]) assert.throws(() => databaseConnection(url));
});

test('production backup key must be a nonsymlink root and service-group file with mode 0640', () => {
  const valid = { uid: 0, gid: 991, mode: 0o100640, isFile: () => true, isSymbolicLink: () => false };
  assert.doesNotThrow(() => assertBackupKeyStat(valid, 991));
  for (const mutation of [
    { uid: 501 }, { gid: 20 }, { mode: 0o100644 },
    { isFile: () => false }, { isSymbolicLink: () => true },
  ]) assert.throws(() => assertBackupKeyStat({ ...valid, ...mutation }, 991));
});

test('production restore accepts only private pawshop-owned backup paths', () => {
  const directory = { uid: 991, mode: 0o40700, isDirectory: () => true, isSymbolicLink: () => false };
  const artifact = { uid: 991, mode: 0o100600, isFile: () => true, isSymbolicLink: () => false };
  assert.doesNotThrow(() => assertBackupDirectoryStat(directory, 991));
  assert.doesNotThrow(() => assertBackupArtifactStat(artifact, 991));
  for (const mutation of [
    { uid: 0 }, { mode: 0o40750 }, { isDirectory: () => false }, { isSymbolicLink: () => true },
  ]) assert.throws(() => assertBackupDirectoryStat({ ...directory, ...mutation }, 991));
  for (const mutation of [
    { uid: 0 }, { mode: 0o100640 }, { isFile: () => false }, { isSymbolicLink: () => true },
  ]) assert.throws(() => assertBackupArtifactStat({ ...artifact, ...mutation }, 991));
});
