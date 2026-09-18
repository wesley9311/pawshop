'use strict';

const { existsSync, lstatSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { isProductionMode } = require('../src/lib/production-modes.cjs');
const { backupKeyFingerprint, readBackupKey } = require('./backup-integrity.cjs');

const EXPECTED_BACKUP_DIR = '/var/backups/pawshop';
const EXPECTED_BACKUP_KEY_FILE = '/etc/pawshop-backup/backup.key';
// Retired keys sit beside the live key rather than in the backup directory, and
// their location is a derived constant rather than another environment field:
// backup.env has a closed field list that the evidence verifier compares field
// by field, so adding one would change the contract of a file already installed
// on the host. A derived constant cannot drift out of the approved location.
const EXPECTED_RETIRED_BACKUP_KEYS_DIR = '/etc/pawshop-backup/retired-keys';
// The name carries the key's own fingerprint, so a swapped or mis-copied file is
// caught by reading it rather than trusted by its name.
const RETIRED_BACKUP_KEY_FILE_NAME = /^backup-([0-9a-f]{12})\.key$/;
const MAXIMUM_RETIRED_BACKUP_KEYS = 32;
const MAXIMUM_BACKUP_KEY_BYTES = 1024;

function productionPrivatePaths(env) {
  const backupDir = resolve(env.PAWSHOP_BACKUP_DIR || '');
  const backupKeyFile = resolve(env.PAWSHOP_BACKUP_KEY_FILE || '');
  if (backupDir !== EXPECTED_BACKUP_DIR || backupKeyFile !== EXPECTED_BACKUP_KEY_FILE) {
    throw new Error('Production backup paths must use the approved private Ubuntu locations.');
  }
  return { backupDir, backupKeyFile, retiredKeysDir: EXPECTED_RETIRED_BACKUP_KEYS_DIR };
}

function databaseConnection(databaseUrl) {
  let url;
  let user;
  let password;
  let database;
  try {
    url = new URL(databaseUrl);
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('Production backup database connection is invalid.');
  }
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || (url.port || '5432') !== '5432' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(user) || !password || !/^[a-z][a-z0-9_]{0,62}$/.test(database) ||
      url.searchParams.size !== 1 || url.searchParams.get('sslmode') !== 'disable' || url.hash) {
    throw new Error('Production backup database connection is outside the approved loopback service.');
  }
  return {
    host: '127.0.0.1', port: '5432',
    user, password, database,
  };
}

function validateProductionBackupEnvironment(env) {
  if (env.NODE_ENV !== 'production' || !isProductionMode(env.PAWSHOP_MODE) ||
      env.PAWSHOP_INFRA_TOPOLOGY !== 'single-host-private') {
    throw new Error('Production backup requires the approved private production topology.');
  }
  return { connection: databaseConnection(env.DATABASE_URL || '') };
}

function assertBackupKeyStat(stat, serviceGid) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== serviceGid ||
      (stat.mode & 0o777) !== 0o640 || stat.size <= 0 || stat.size > MAXIMUM_BACKUP_KEY_BYTES) {
    throw new Error('Production backup key must be a root-owned regular file readable only by the pawshop service group.');
  }
}

// The retired key directory is the only place a second key may live, so it gets
// its own shape: root-owned, group-readable by the backup service and not
// writable by it. The service can read a retired key to verify old sets but must
// never be able to add one, which would let a compromised backup process mint a
// key that authenticates invented history.
function assertRetiredBackupKeysDirectoryStat(stat, serviceGid) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== serviceGid ||
      (stat.mode & 0o777) !== 0o750) {
    throw new Error('Retired production backup keys must live in a root-owned directory readable only by the pawshop service group.');
  }
}

function retiredBackupKeyFingerprint(fileName) {
  const match = RETIRED_BACKUP_KEY_FILE_NAME.exec(fileName || '');
  return match ? match[1] : null;
}

// Ordering and identity are decided here, apart from the filesystem, because
// this is where a rotation can go quietly wrong: a retired key that duplicates
// the live one means the rotation never actually happened, and a name that
// disagrees with its contents means someone copied the wrong file in. Both are
// refused rather than resolved, because either would leave verification passing
// against a key the operator does not believe is in play.
function assembleBackupKeyRing(current, retired) {
  if (!current || !current.key || !current.fingerprint) throw new Error('The live production backup key is missing.');
  if (!Array.isArray(retired)) throw new Error('Retired production backup keys must be a list.');
  if (retired.length > MAXIMUM_RETIRED_BACKUP_KEYS) {
    throw new Error('Too many retired production backup keys are installed.');
  }
  const seen = new Set([current.fingerprint]);
  const ring = [Object.freeze({ ...current, source: 'current' })];
  for (const entry of retired) {
    if (!entry || !entry.key || !entry.fingerprint) throw new Error('A retired production backup key is unreadable.');
    if (seen.has(entry.fingerprint)) {
      throw new Error('The production backup key ring repeats a key; operator review is required.');
    }
    seen.add(entry.fingerprint);
    ring.push(Object.freeze({ ...entry, source: 'retired' }));
  }
  return Object.freeze(ring);
}

// Reads the live key plus every retired key, in that order, so callers can match
// a manifest against all of them. An absent retired directory is the normal
// state before the first rotation and simply means a ring of one.
//
// The locations come from the approved constants rather than from the
// environment on purpose. The backup services carry backup.env, but the evidence
// writer runs as root outside any unit that does, so an environment-derived path
// would resolve to its working directory there and refuse to load a key that is
// sitting in exactly the right place. The constants are the approved locations
// and productionPrivatePaths enforces the same values for every caller that does
// take them from the environment.
function readProductionBackupKeyRing({ serviceGid }) {
  const backupKeyFile = EXPECTED_BACKUP_KEY_FILE;
  const retiredKeysDir = EXPECTED_RETIRED_BACKUP_KEYS_DIR;
  assertBackupKeyStat(lstatSync(backupKeyFile), serviceGid);
  const currentKey = readBackupKey(backupKeyFile);
  const current = { fingerprint: backupKeyFingerprint(currentKey), key: currentKey, file: backupKeyFile };
  if (!existsSync(retiredKeysDir)) return assembleBackupKeyRing(current, []);
  assertRetiredBackupKeysDirectoryStat(lstatSync(retiredKeysDir), serviceGid);
  const retired = readdirSync(retiredKeysDir).sort().map((name) => {
    const fingerprint = retiredBackupKeyFingerprint(name);
    if (!fingerprint) throw new Error('The retired production backup key directory holds an unrecognised file name.');
    const file = join(retiredKeysDir, name);
    assertBackupKeyStat(lstatSync(file), serviceGid);
    const key = readBackupKey(file);
    if (backupKeyFingerprint(key) !== fingerprint) {
      throw new Error('A retired production backup key does not match the fingerprint in its file name.');
    }
    return { fingerprint, key, file };
  });
  return assembleBackupKeyRing(current, retired);
}

function assertBackupDirectoryStat(stat, serviceUid) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== serviceUid || (stat.mode & 0o777) !== 0o700) {
    throw new Error('Production backup directory must be a pawshop-owned nonsymlink directory with mode 0700.');
  }
}

function assertBackupArtifactStat(stat, serviceUid) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== serviceUid || (stat.mode & 0o777) !== 0o600) {
    throw new Error('Production backup artifacts must be pawshop-owned nonsymlink files with mode 0600.');
  }
}

module.exports = {
  EXPECTED_BACKUP_DIR,
  EXPECTED_BACKUP_KEY_FILE,
  EXPECTED_RETIRED_BACKUP_KEYS_DIR,
  MAXIMUM_RETIRED_BACKUP_KEYS,
  RETIRED_BACKUP_KEY_FILE_NAME,
  assembleBackupKeyRing,
  assertBackupArtifactStat,
  assertBackupDirectoryStat,
  assertBackupKeyStat,
  assertRetiredBackupKeysDirectoryStat,
  databaseConnection,
  productionPrivatePaths,
  readProductionBackupKeyRing,
  retiredBackupKeyFingerprint,
  validateProductionBackupEnvironment,
};
