import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { constrainedBackupPath, criticalDataSha256, digestFile, equalHex, readBackupKey } = require('./backup-integrity.cjs');
const { ensureBackupKey, ensurePrivateRuntime } = require('./private-runtime.cjs');
const runtime = ensurePrivateRuntime();
ensureBackupKey();
const pgBin = '/opt/homebrew/opt/postgresql@17/bin';
const dbEnv = { ...process.env, PGPASSWORD: runtime.env.POSTGRES_PASSWORD };
const latest = JSON.parse(readFileSync(join(runtime.backupDir, 'latest.json'), 'utf8'));
const manifestFile = constrainedBackupPath(runtime.backupDir, latest.manifest_file, 'Backup manifest');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));

if (manifest.schema !== 'pawshop-real-backup-v2') throw new Error('Unsupported PawShop backup manifest. Create a new backup with backup:real.');
const encryptedFile = constrainedBackupPath(runtime.backupDir, manifest.encrypted_file, 'Encrypted backup');
const backupKey = readBackupKey(runtime.backupKeyFile);
const actualHash = await digestFile(encryptedFile);
const actualHmac = await digestFile(encryptedFile, { hmacKey: backupKey });
if (!equalHex(actualHash, manifest.sha256)) throw new Error('Encrypted backup checksum mismatch.');
if (!equalHex(actualHmac, manifest.hmac_sha256)) throw new Error('Encrypted backup authentication failed.');

const suffix = `${new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 17)}_${process.pid}`;
const restoreDatabase = `pawshop_restore_${suffix}`;
if (!/^pawshop_restore_[0-9]{17}_[0-9]+$/.test(restoreDatabase)) throw new Error('Unsafe restore database name.');
const tempDir = mkdtempSync(join(runtime.privateDir, '.restore-'));
const plainDump = join(tempDir, 'database.dump');

function adminQuery(sql) {
  return execFileSync(`${pgBin}/psql`, [
    '-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', '-d', 'postgres', '-At', '-c', sql,
  ], { env: dbEnv, encoding: 'utf8' }).trim();
}

if (adminQuery(`SELECT count(*) FROM pg_database WHERE datname = '${restoreDatabase}'`) !== '0') {
  throw new Error(`Restore target already exists: ${restoreDatabase}`);
}

let databaseCreated = false;
let verificationData;
let operationError;
try {
  execFileSync('/usr/bin/openssl', [
    'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-in', encryptedFile,
    '-out', plainDump, '-pass', `file:${runtime.backupKeyFile}`,
  ], { stdio: 'inherit' });
  chmodSync(plainDump, 0o600);
  execFileSync(`${pgBin}/createdb`, [
    '-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', restoreDatabase,
  ], { env: dbEnv, stdio: 'inherit' });
  databaseCreated = true;
  execFileSync(`${pgBin}/pg_restore`, [
    '-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', '-d', restoreDatabase,
    '--no-owner', '--no-acl', '--exit-on-error', plainDump,
  ], { env: dbEnv, stdio: 'inherit' });
  function restoredQuery(sql) {
    return execFileSync(`${pgBin}/psql`, [
      '-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', '-d', restoreDatabase, '-At', '-c', sql,
    ], { env: dbEnv, encoding: 'utf8' }).trim();
  }

  const restoredCriticalHash = criticalDataSha256(restoredQuery);
  const restoredCounts = {
    products: Number(restoredQuery('SELECT count(*) FROM product WHERE deleted_at IS NULL;')),
    variants: Number(restoredQuery('SELECT count(*) FROM product_variant WHERE deleted_at IS NULL;')),
    customers: Number(restoredQuery('SELECT count(*) FROM customer WHERE deleted_at IS NULL;')),
    orders: Number(restoredQuery('SELECT count(*) FROM "order" WHERE deleted_at IS NULL;')),
    owner_users: Number(restoredQuery('SELECT count(*) FROM "user" WHERE deleted_at IS NULL;')),
  };
  verificationData = {
    schema: 'pawshop-real-restore-verification-v2',
    verified_at: new Date().toISOString(),
    source_manifest: manifestFile,
    restored_database: restoreDatabase,
    database_retained: process.env.PAWSHOP_KEEP_RESTORE_DB === '1',
    encrypted_backup_sha256: manifest.sha256,
    critical_data_sha256: restoredCriticalHash,
    counts: restoredCounts,
  };
} catch (error) {
  operationError = error;
}

const cleanupErrors = [];
try {
  rmSync(tempDir, { recursive: true, force: true });
} catch (error) {
  cleanupErrors.push(error);
}
if (databaseCreated && (operationError || process.env.PAWSHOP_KEEP_RESTORE_DB !== '1')) {
  try {
    execFileSync(`${pgBin}/dropdb`, [
      '-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', restoreDatabase,
    ], { env: dbEnv, stdio: 'inherit' });
  } catch (error) {
    cleanupErrors.push(error);
  }
}

if (operationError || cleanupErrors.length > 0) {
  throw new AggregateError([operationError, ...cleanupErrors].filter(Boolean), 'PawShop restore verification failed or could not clean up safely.');
}

const verificationFile = join(runtime.backupDir, `${restoreDatabase}.verification.json`);
const verificationTemporary = `${verificationFile}.${process.pid}.tmp`;
try {
  writeFileSync(verificationTemporary, `${JSON.stringify(verificationData, null, 2)}\n`, { mode: 0o600 });
  chmodSync(verificationTemporary, 0o600);
  renameSync(verificationTemporary, verificationFile);
} finally {
  rmSync(verificationTemporary, { force: true });
}
console.log(`Real backup restored and verified in isolated database: ${restoreDatabase}`);
console.log(`Verification record: ${verificationFile}`);
