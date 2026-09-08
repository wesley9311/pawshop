import { spawn } from 'node:child_process';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const { digestFile, readBackupKey } = require('./backup-integrity.cjs');
const { assertBackupKeyStat, databaseConnection, productionPrivatePaths } = require('./production-private-paths.cjs');
const { validateProductionEnvironment } = require('../src/lib/production-policy.cjs');

const config = validateProductionEnvironment(process.env);
if (process.platform !== 'linux' || config.topology !== 'single-host-private') {
  throw new Error('Production backup requires the Linux single-host private topology.');
}
const { backupDir, backupKeyFile } = productionPrivatePaths(process.env);
const connection = databaseConnection(config.databaseUrl);
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
chmodSync(backupDir, 0o700);
assertBackupKeyStat(lstatSync(backupKeyFile), process.getgid());
const backupKey = readBackupKey(backupKeyFile);

const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '').replace('Z', 'Z');
const base = `pawshop_production_${stamp}`;
const encryptedTemp = join(backupDir, `.${base}.dump.enc.tmp`);
const encryptedFile = join(backupDir, `${base}.dump.enc`);
const manifestFile = join(backupDir, `${base}.manifest.json`);
const latestFile = join(backupDir, 'latest.json');
const dbEnv = {
  ...process.env,
  PGPASSWORD: connection.password,
  PGCONNECT_TIMEOUT: '5',
  PGOPTIONS: '-c statement_timeout=300000',
};

function atomicPrivateWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function childCompleted(child) {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Production backup child process could not start.')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Production backup child process failed.')));
  });
}

async function createEncryptedDump() {
  const encryptedFd = openSync(encryptedTemp, 'wx', 0o600);
  let dump;
  let encrypt;
  try {
    dump = spawn('pg_dump', [
      '-h', connection.host, '-p', connection.port, '-U', connection.user,
      '-d', connection.database, '--format=custom', '--compress=9', '--no-owner',
      '--no-acl',
    ], { env: dbEnv, stdio: ['ignore', 'pipe', 'ignore'] });
    encrypt = spawn('openssl', [
      'enc', '-aes-256-cbc', '-pbkdf2', '-salt',
      '-pass', `file:${backupKeyFile}`,
    ], { stdio: ['pipe', encryptedFd, 'ignore'] });
  } catch {
    dump?.kill('SIGKILL');
    throw new Error('Production backup child process could not start.');
  } finally {
    closeSync(encryptedFd);
  }
  const timer = setTimeout(() => {
    dump.kill('SIGKILL');
    encrypt.kill('SIGKILL');
  }, 300000);
  try {
    await Promise.all([
      pipeline(dump.stdout, encrypt.stdin),
      childCompleted(dump),
      childCompleted(encrypt),
    ]);
  } catch {
    dump.kill('SIGKILL');
    encrypt.kill('SIGKILL');
    throw new Error('Production database backup or encryption failed.');
  } finally {
    clearTimeout(timer);
  }
}

try {
  await createEncryptedDump();
  chmodSync(encryptedTemp, 0o600);
  renameSync(encryptedTemp, encryptedFile);
} finally {
  rmSync(encryptedTemp, { force: true });
}

const sha256 = await digestFile(encryptedFile);
const hmacSha256 = await digestFile(encryptedFile, { hmacKey: backupKey });
const manifest = {
  schema: 'pawshop-production-backup-v1',
  created_at: new Date().toISOString(),
  source_database: connection.database,
  encrypted_file: encryptedFile,
  encryption: 'AES-256-CBC PBKDF2',
  sha256,
  hmac_sha256: hmacSha256,
  size_bytes: statSync(encryptedFile).size,
};
atomicPrivateWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
atomicPrivateWrite(latestFile, `${JSON.stringify({ manifest_file: manifestFile }, null, 2)}\n`);

console.log('Encrypted production database backup completed.');
