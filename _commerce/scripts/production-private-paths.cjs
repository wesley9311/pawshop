'use strict';

const { resolve } = require('node:path');

const EXPECTED_BACKUP_DIR = '/var/backups/pawshop';
const EXPECTED_BACKUP_KEY_FILE = '/etc/pawshop/backup.key';

function productionPrivatePaths(env) {
  const backupDir = resolve(env.PAWSHOP_BACKUP_DIR || '');
  const backupKeyFile = resolve(env.PAWSHOP_BACKUP_KEY_FILE || '');
  if (backupDir !== EXPECTED_BACKUP_DIR || backupKeyFile !== EXPECTED_BACKUP_KEY_FILE) {
    throw new Error('Production backup paths must use the approved private Ubuntu locations.');
  }
  return { backupDir, backupKeyFile };
}

function databaseConnection(databaseUrl) {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (url.hostname !== '127.0.0.1' || (url.port || '5432') !== '5432' || !url.username || !url.password ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(database)) {
    throw new Error('Production backup database connection is outside the approved loopback service.');
  }
  return {
    host: '127.0.0.1', port: '5432',
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database,
  };
}

function assertBackupKeyStat(stat, serviceGid) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== serviceGid || (stat.mode & 0o777) !== 0o640) {
    throw new Error('Production backup key must be a root-owned regular file readable only by the pawshop service group.');
  }
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
  assertBackupArtifactStat,
  assertBackupDirectoryStat,
  assertBackupKeyStat,
  databaseConnection,
  productionPrivatePaths,
};
