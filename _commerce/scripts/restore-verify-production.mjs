import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, renameSync, rmSync, statfsSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const { assertProductionBackupManifest, backupManifestHmac, digestFile, equalHex, readBackupKey } = require('./backup-integrity.cjs');

const root = '/var/lib/pawshop-restore';
const inputDir = join(root, 'input');
const workDir = join(root, 'work');
const verificationDir = join(root, 'verifications');
const manifestFile = join(inputDir, 'manifest.json');
const keyFile = join(inputDir, 'backup.key');
const lockFile = join(workDir, 'restore.lock');
const pgBin = '/usr/lib/postgresql/17/bin';
const operationDeadline = Date.now() + 10 * 60 * 1000;

if (process.platform !== 'linux' || process.getuid() === 0) {
  throw new Error('Production restore verification requires the unprivileged Ubuntu restore account.');
}
const restoreUid = process.getuid();
const restoreGid = process.getgid();

function assertDirectory(file, { uid, gid, mode, label }) {
  const stat = lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== mode) {
    throw new Error(`${label} has unsafe ownership, type, or permissions.`);
  }
}

function assertInputFile(file, label, maxBytes) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== restoreGid ||
      (stat.mode & 0o777) !== 0o640 || stat.size <= 0 || stat.size > maxBytes) {
    throw new Error(`${label} has unsafe ownership, type, permissions, or size.`);
  }
  return stat;
}

assertDirectory(root, { uid: 0, gid: restoreGid, mode: 0o750, label: 'Restore root' });
assertDirectory(inputDir, { uid: 0, gid: restoreGid, mode: 0o750, label: 'Restore input directory' });
assertDirectory(workDir, { uid: restoreUid, gid: restoreGid, mode: 0o700, label: 'Restore work directory' });
assertDirectory(verificationDir, { uid: restoreUid, gid: restoreGid, mode: 0o700, label: 'Restore verification directory' });
assertInputFile(manifestFile, 'Restore manifest', 64 * 1024);
assertInputFile(keyFile, 'Restore key', 1024);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
} catch {
  throw new Error('Restore manifest is not valid JSON.');
}
assertProductionBackupManifest(manifest);
const encryptedFile = join(inputDir, manifest.encrypted_file);
const encryptedStat = assertInputFile(encryptedFile, 'Encrypted restore archive', Number.MAX_SAFE_INTEGER);
if (!Number.isSafeInteger(manifest.size_bytes) || manifest.size_bytes !== encryptedStat.size) {
  throw new Error('Encrypted restore archive size does not match its manifest.');
}
const backupKey = readBackupKey(keyFile);
if (!equalHex(backupManifestHmac(manifest, backupKey), manifest.manifest_hmac_sha256)) {
  throw new Error('Production backup manifest authentication failed.');
}
const [actualHash, actualHmac] = await Promise.all([
  digestFile(encryptedFile),
  digestFile(encryptedFile, { hmacKey: backupKey }),
]);
if (!equalHex(actualHash, manifest.sha256) || !equalHex(actualHmac, manifest.hmac_sha256)) {
  throw new Error('Encrypted production backup authentication failed.');
}

const fileSystem = statfsSync(root);
const availableBytes = fileSystem.bavail * fileSystem.bsize;
const requiredBytes = Math.max(8 * 1024 ** 3, encryptedStat.size * 10);
if (!Number.isSafeInteger(availableBytes) || availableBytes < requiredBytes) {
  throw new Error('Isolated restore volume does not have the required free space.');
}

let lockFd;
try {
  lockFd = openSync(lockFile, 'wx', 0o600);
} catch {
  throw new Error('Another restore may be running or a prior interrupted restore requires operator cleanup.');
}

const runDir = mkdtempSync(join(workDir, 'run-'));
chmodSync(runDir, 0o700);
const dataDir = join(runDir, 'postgres');
const socketDir = join(runDir, 'socket');
const postgresLog = join(runDir, 'postgres.log');
mkdirSync(socketDir, { mode: 0o700 });
const port = 55000 + (process.pid % 1000);
let postgresStartAttempted = false;
let verificationData;
let operationFailed = false;

function remainingTimeout(maximum = 120000) {
  const remaining = operationDeadline - Date.now();
  if (remaining <= 0) throw new Error('Isolated production restore exceeded its operation deadline.');
  return Math.max(1, Math.min(maximum, remaining));
}

function pgCommand(command, args, { cleanup = false } = {}) {
  try {
    return execFileSync(join(pgBin, command), args, {
      encoding: 'utf8', timeout: cleanup ? 120000 : remainingTimeout(), maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`Isolated PostgreSQL ${cleanup ? 'cleanup' : 'operation'} failed.`);
  }
}

function postgresIsRunning() {
  try {
    execFileSync(join(pgBin, 'pg_ctl'), ['-D', dataDir, 'status'], {
      timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function childCompleted(child) {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Isolated restore child process could not start.')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Isolated restore child process failed.')));
  });
}

function killGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

async function restoreArchive() {
  const restoreTimeout = remainingTimeout(10 * 60 * 1000);
  let decrypt;
  let restore;
  try {
    decrypt = spawn('/usr/bin/openssl', [
      'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-in', encryptedFile, '-pass', `file:${keyFile}`,
    ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    restore = spawn(join(pgBin, 'pg_restore'), [
      '-h', socketDir, '-p', String(port), '-U', 'pawshop_restore', '-d', 'postgres',
      '--no-owner', '--no-acl', '--exit-on-error',
    ], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  } catch {
    killGroup(decrypt);
    killGroup(restore);
    throw new Error('Isolated restore child process could not start.');
  }
  const timer = setTimeout(() => {
    killGroup(decrypt);
    killGroup(restore);
  }, restoreTimeout);
  try {
    await Promise.all([
      pipeline(decrypt.stdout, restore.stdin),
      childCompleted(decrypt),
      childCompleted(restore),
    ]);
  } catch {
    killGroup(decrypt);
    killGroup(restore);
    throw new Error('Encrypted archive could not be restored in the isolated cluster.');
  } finally {
    clearTimeout(timer);
  }
}

try {
  pgCommand('initdb', ['-D', dataDir, '--username=pawshop_restore', '--auth-local=trust', '--auth-host=reject']);
  postgresStartAttempted = true;
  pgCommand('pg_ctl', [
    '-D', dataDir, '-w', 'start', '-l', postgresLog, '-o',
    `-c listen_addresses= -c unix_socket_directories=${socketDir} -c port=${port}`,
  ]);
  await restoreArchive();
  const query = sql => pgCommand('psql', [
    '-h', socketDir, '-p', String(port), '-U', 'pawshop_restore', '-d', 'postgres',
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql,
  ]);
  const count = table => Number(query(`SELECT count(*) FROM ${table} WHERE deleted_at IS NULL;`));
  const counts = {
    products: count('product'), variants: count('product_variant'), images: count('image'),
    customers: count('customer'), orders: count('"order"'), owner_users: count('"user"'),
  };
  if (Object.values(counts).some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Isolated restore returned invalid critical table counts.');
  }
  verificationData = {
    schema: 'pawshop-production-restore-verification-v1', verified_at: new Date().toISOString(),
    source_database: manifest.source_database, encrypted_backup_sha256: actualHash,
    critical_table_counts: counts, isolated_cluster_removed: true,
  };
} catch {
  operationFailed = true;
} finally {
  let cleanupFailed = false;
  if (postgresStartAttempted && postgresIsRunning()) {
    try { pgCommand('pg_ctl', ['-D', dataDir, '-w', 'stop', '-m', 'immediate'], { cleanup: true }); }
    catch { cleanupFailed = true; }
  }
  if (!cleanupFailed) {
    try { rmSync(runDir, { recursive: true, force: true }); } catch { cleanupFailed = true; }
  }
  closeSync(lockFd);
  if (!cleanupFailed) rmSync(lockFile, { force: true });
  if (operationFailed || cleanupFailed) {
    throw new Error('Production restore verification failed; inspect the isolated restore directory before retrying.');
  }
}

const verificationFile = join(verificationDir, `verification-${Date.now()}.json`);
const verificationTemporary = `${verificationFile}.${process.pid}.tmp`;
try {
  writeFileSync(verificationTemporary, `${JSON.stringify(verificationData, null, 2)}\n`, { mode: 0o600 });
  chmodSync(verificationTemporary, 0o600);
  renameSync(verificationTemporary, verificationFile);
} finally {
  rmSync(verificationTemporary, { force: true });
}
console.log('Production backup passed isolated restore verification and the temporary cluster was removed.');
