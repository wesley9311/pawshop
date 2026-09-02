'use strict';

const { randomBytes } = require('node:crypto');
const { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { parseEnv } = require('node:util');

const privateDir = join(homedir(), 'Documents', 'PawShop_Private', 'development');
const envFile = join(privateDir, 'commerce.env');
const adminFile = join(privateDir, 'local-admin.txt');
const dataDir = join(privateDir, 'postgres-17');
const socketDir = join(privateDir, 'postgres-socket');
const logFile = join(privateDir, 'postgres.log');
const backupDir = join(privateDir, 'backups');
const backupKeyFile = join(privateDir, 'backup.key');

function secureWrite(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function ensurePrivateRuntime() {
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  chmodSync(privateDir, 0o700);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);

  if (!existsSync(envFile)) {
    const dbPassword = randomBytes(24).toString('base64url');
    secureWrite(envFile, [
      'PAWSHOP_MODE=local-admin-only',
      `DATABASE_URL=postgresql://pawshop:${dbPassword}@127.0.0.1:54329/pawshop_dev`,
      `POSTGRES_PASSWORD=${dbPassword}`,
      `JWT_SECRET=${randomBytes(32).toString('hex')}`,
      `COOKIE_SECRET=${randomBytes(32).toString('hex')}`,
      '',
    ].join('\n'));
  }
  chmodSync(envFile, 0o600);

  if (!existsSync(adminFile)) {
    secureWrite(adminFile, [
      'ADMIN_EMAIL=owner@pawshop.local',
      `ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}`,
      '',
    ].join('\n'));
  }
  chmodSync(adminFile, 0o600);

  return {
    privateDir,
    envFile,
    adminFile,
    dataDir,
    socketDir,
    logFile,
    backupDir,
    backupKeyFile,
    env: parseEnv(readFileSync(envFile, 'utf8')),
    admin: parseEnv(readFileSync(adminFile, 'utf8')),
  };
}

function ensureBackupKey({ allowCreate = false } = {}) {
  ensurePrivateRuntime();
  if (!existsSync(backupKeyFile)) {
    const hasEncryptedBackups = readdirSync(backupDir).some((name) => name.endsWith('.dump.enc'));
    if (!allowCreate || hasEncryptedBackups) {
      throw new Error('PawShop backup key is missing. Existing backups must not be overwritten with a new key.');
    }
    secureWrite(backupKeyFile, `${randomBytes(32).toString('hex')}\n`);
  }
  chmodSync(backupKeyFile, 0o600);
  return backupKeyFile;
}

module.exports = { ensureBackupKey, ensurePrivateRuntime };
