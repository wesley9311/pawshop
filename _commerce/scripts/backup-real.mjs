import { execFileSync } from 'node:child_process';
import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { digestFile, readBackupKey } = require('./backup-integrity.cjs');
const { ensureBackupKey, ensurePrivateRuntime } = require('./private-runtime.cjs');
const { validateLocalEnvironment } = require('../src/lib/local-policy.cjs');
const runtime = ensurePrivateRuntime();
ensureBackupKey({ allowCreate: true });
validateLocalEnvironment({ ...process.env, ...runtime.env, NODE_ENV: 'development' });

const pgBin = '/opt/homebrew/opt/postgresql@17/bin';
const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '').replace('Z', 'Z');
const base = `pawshop_dev_${stamp}`;
const plainTemp = join(runtime.backupDir, `.${base}.dump.tmp`);
const encryptedTemp = join(runtime.backupDir, `.${base}.dump.enc.tmp`);
const encryptedFile = join(runtime.backupDir, `${base}.dump.enc`);
const manifestFile = join(runtime.backupDir, `${base}.manifest.json`);
const latestFile = join(runtime.backupDir, 'latest.json');
const dbEnv = { ...process.env, PGPASSWORD: runtime.env.POSTGRES_PASSWORD };

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

try {
  execFileSync(`${pgBin}/pg_dump`, [
    '-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', '-d', 'pawshop_dev',
    '--format=custom', '--compress=9', '--no-owner', '--no-acl', '--file', plainTemp,
  ], { env: dbEnv, stdio: 'inherit' });
  chmodSync(plainTemp, 0o600);
  execFileSync('/usr/bin/openssl', [
    'enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-in', plainTemp,
    '-out', encryptedTemp, '-pass', `file:${runtime.backupKeyFile}`,
  ], { stdio: 'inherit' });
  chmodSync(encryptedTemp, 0o600);
  renameSync(encryptedTemp, encryptedFile);
} finally {
  rmSync(plainTemp, { force: true });
  rmSync(encryptedTemp, { force: true });
}

const backupKey = readBackupKey(runtime.backupKeyFile);
const sha256 = await digestFile(encryptedFile);
const hmacSha256 = await digestFile(encryptedFile, { hmacKey: backupKey });
const manifest = {
  schema: 'pawshop-real-backup-v2',
  created_at: new Date().toISOString(),
  source_database: 'pawshop_dev',
  encrypted_file: encryptedFile,
  encryption: 'AES-256-CBC PBKDF2',
  sha256,
  hmac_sha256: hmacSha256,
  size_bytes: statSync(encryptedFile).size,
};
atomicPrivateWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
atomicPrivateWrite(latestFile, `${JSON.stringify({ manifest_file: manifestFile }, null, 2)}\n`);

console.log('Encrypted backup of the real local PawShop database completed.');
console.log(`Manifest: ${manifestFile}`);
