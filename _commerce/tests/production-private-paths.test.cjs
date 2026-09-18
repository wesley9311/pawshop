'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  MAXIMUM_RETIRED_BACKUP_KEYS,
  assembleBackupKeyRing,
  assertBackupArtifactStat,
  assertBackupDirectoryStat,
  assertBackupKeyStat,
  assertRetiredBackupKeysDirectoryStat,
  databaseConnection,
  productionPrivatePaths,
  retiredBackupKeyFingerprint,
  validateProductionBackupEnvironment,
} = require('../scripts/production-private-paths.cjs');
const { backupKeyFingerprint } = require('../scripts/backup-integrity.cjs');

const privatePaths = readFileSync(resolve(__dirname, '..', 'scripts/production-private-paths.cjs'), 'utf8');

test('the key ring loader reads the approved locations rather than the environment', () => {
  // A regression this pins down: the loader used to resolve its paths from
  // process.env. The backup services carry backup.env, but the backup-and-restore
  // evidence writer runs as root outside any unit that does, so there the two
  // variables are unset, resolve('') yields the working directory, and the loader
  // refused to load a key that was sitting in exactly the right place.
  const loader = privatePaths.slice(
    privatePaths.indexOf('function readProductionBackupKeyRing('),
    privatePaths.indexOf('function assertBackupDirectoryStat('),
  );
  assert.notEqual(loader.length, 0);
  assert.match(loader, /const backupKeyFile = EXPECTED_BACKUP_KEY_FILE;/);
  assert.match(loader, /const retiredKeysDir = EXPECTED_RETIRED_BACKUP_KEYS_DIR;/);
  assert.doesNotMatch(loader, /process\.env/);
});

test('production backup locations cannot drift into public or release paths', () => {
  assert.deepEqual(productionPrivatePaths({
    PAWSHOP_BACKUP_DIR: '/var/backups/pawshop',
    PAWSHOP_BACKUP_KEY_FILE: '/etc/pawshop-backup/backup.key',
  }), {
    backupDir: '/var/backups/pawshop',
    backupKeyFile: '/etc/pawshop-backup/backup.key',
    // Derived from a constant rather than added to backup.env: that file has a
    // closed field list the evidence verifier compares field by field, so a new
    // environment field there would change the contract of a file already
    // installed on the host.
    retiredKeysDir: '/etc/pawshop-backup/retired-keys',
  });
  assert.throws(() => productionPrivatePaths({
    PAWSHOP_BACKUP_DIR: '/srv/pawshop/current/backups',
    PAWSHOP_BACKUP_KEY_FILE: '/etc/pawshop-backup/backup.key',
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
    'postgresql://pawshop:secret@127.0.0.1:5432/pawshop?sslmode=require',
    'postgresql://pawshop:secret@127.0.0.1:5432/pawshop?sslmode=disable&extra=1',
  ]) assert.throws(() => databaseConnection(url));
});

test('production backup uses a minimal dedicated environment', () => {
  const env = {
    NODE_ENV: 'production', PAWSHOP_MODE: 'production-admin-only',
    PAWSHOP_INFRA_TOPOLOGY: 'single-host-private',
    DATABASE_URL: 'postgresql://pawshop_backup:secret@127.0.0.1:5432/pawshop?sslmode=disable',
  };
  assert.equal(validateProductionBackupEnvironment(env).connection.user, 'pawshop_backup');
  assert.throws(() => validateProductionBackupEnvironment({ ...env, PAWSHOP_MODE: 'wrong' }));
});

test('production backup key must be a nonsymlink root and service-group file with mode 0640', () => {
  const valid = { uid: 0, gid: 991, mode: 0o100640, size: 64, isFile: () => true, isSymbolicLink: () => false };
  assert.doesNotThrow(() => assertBackupKeyStat(valid, 991));
  for (const mutation of [
    { uid: 501 }, { gid: 20 }, { mode: 0o100644 },
    { isFile: () => false }, { isSymbolicLink: () => true },
    // An empty or oversized file is not a key: a zero-byte key would HMAC with
    // empty key material and authenticate nothing it should.
    { size: 0 }, { size: 4096 },
  ]) assert.throws(() => assertBackupKeyStat({ ...valid, ...mutation }, 991));
});

test('a retired key directory is root-owned and never writable by the backup service', () => {
  const directory = { uid: 0, gid: 991, mode: 0o40750, isDirectory: () => true, isSymbolicLink: () => false };
  assert.doesNotThrow(() => assertRetiredBackupKeysDirectoryStat(directory, 991));
  for (const mutation of [
    { uid: 991 }, { gid: 0 },
    // 0755 would expose retired key material to every local account and 0770
    // would let the backup service mint a key of its own.
    { mode: 0o40755 }, { mode: 0o40770 }, { mode: 0o40700 },
    { isDirectory: () => false }, { isSymbolicLink: () => true },
  ]) assert.throws(() => assertRetiredBackupKeysDirectoryStat({ ...directory, ...mutation }, 991));
});

test('a retired key file name carries its own fingerprint', () => {
  assert.equal(retiredBackupKeyFingerprint('backup-0123456789ab.key'), '0123456789ab');
  for (const name of [
    'backup.key', 'backup-0123456789ab.key.bak', 'backup-0123456789AB.key',
    'backup-0123456789ab.pem', 'other-0123456789ab.key', 'backup-0123456.key', '',
  ]) assert.equal(retiredBackupKeyFingerprint(name), null, name);
  assert.equal(retiredBackupKeyFingerprint(undefined), null);
});

test('the key ring keeps the live key first and refuses a rotation that did not happen', () => {
  const key = Buffer.from('current-key-material');
  const retired = Buffer.from('retired-key-material');
  const current = { fingerprint: backupKeyFingerprint(key), key, file: '/etc/pawshop-backup/backup.key' };
  const previous = {
    fingerprint: backupKeyFingerprint(retired), key: retired,
    file: '/etc/pawshop-backup/retired-keys/backup-0123456789ab.key',
  };
  const ring = assembleBackupKeyRing(current, [previous]);
  assert.equal(ring.length, 2);
  assert.equal(ring[0].source, 'current');
  assert.equal(ring[1].source, 'retired');
  assert.equal(Object.isFrozen(ring), true);
  // A ring of one is the normal state before the first rotation.
  assert.equal(assembleBackupKeyRing(current, []).length, 1);

  // A retired file that duplicates the live key means the rotation never actually
  // happened. Matching would still succeed, so this is refused instead of resolved.
  assert.throws(() => assembleBackupKeyRing(current, [current]), /repeats a key/);
  assert.throws(() => assembleBackupKeyRing(null, []), /live production backup key is missing/);
  assert.throws(() => assembleBackupKeyRing(current, null), /must be a list/);
  assert.throws(() => assembleBackupKeyRing(current, [null]), /unreadable/);
  assert.throws(() => assembleBackupKeyRing(current, [{ key: retired }]), /unreadable/);
  const tooMany = Array.from({ length: MAXIMUM_RETIRED_BACKUP_KEYS + 1 }, (unused, index) => ({
    fingerprint: `fingerprint-${index}`, key: Buffer.from(`retired-${index}`),
  }));
  assert.throws(() => assembleBackupKeyRing(current, tooMany), /Too many retired/);
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
