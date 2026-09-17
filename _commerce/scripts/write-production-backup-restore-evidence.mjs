import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assertProductionBackupManifest, backupManifestHmac, digestFile, equalHex, readBackupKey,
} = require('./backup-integrity.cjs');
const { OFFSITE_ENVIRONMENT_FIELDS, offsiteReceiptIsValid, validateOffsiteConfig } = require('./offsite-backup-policy.cjs');
const { assertRestoreVerification, backupRestoreEvidence } = require('./first-production-backup-evidence.cjs');
const { assertBackupRestoreEvidence, assertMigrationEvidence } = require('./release-evidence.cjs');
const { RELEASE_ID } = require('./release-manifest.cjs');
const { parseProductionEnvironmentFile } = require('./production-env-file.cjs');
const { databaseConnection, validateProductionBackupEnvironment } = require('./production-private-paths.cjs');

if (process.platform !== 'linux' || process.getuid() !== 0) {
  throw new Error('Backup and restore evidence must be written by root on Linux.');
}
const release = resolve(process.argv[2] || '');
const releaseId = process.argv[3];
const contentSha256 = process.argv[4];
const manifestName = process.argv[5];
const verificationName = process.argv[6];
if (process.argv.length !== 7 || !RELEASE_ID.test(releaseId || '') ||
    release !== `/srv/pawshop-commerce/releases/${releaseId}` ||
    !/^pawshop_production_[0-9]{8}T[0-9]{9}Z\.manifest\.json$/.test(manifestName || '') ||
    !/^verification-[0-9]+\.json$/.test(verificationName || '')) {
  throw new Error('Backup evidence arguments are invalid.');
}

const backupUid = Number(execFileSync('/usr/bin/id', ['-u', 'pawshop-backup'], { encoding: 'utf8' }).trim());
const backupGid = Number(execFileSync('/usr/bin/id', ['-g', 'pawshop-backup'], { encoding: 'utf8' }).trim());
const restoreUid = Number(execFileSync('/usr/bin/id', ['-u', 'pawshop-restore'], { encoding: 'utf8' }).trim());
const restoreGid = Number(execFileSync('/usr/bin/id', ['-g', 'pawshop-restore'], { encoding: 'utf8' }).trim());
const pawshopGid = Number(execFileSync('/usr/bin/id', ['-g', 'pawshop'], { encoding: 'utf8' }).trim());
function assertFile(path, { uid, gid, mode, label, maximum = Number.MAX_SAFE_INTEGER }) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (stat.mode & 0o777) !== mode || stat.size <= 0 || stat.size > maximum) {
    throw new Error(`${label} has unsafe ownership, type, permissions, or size.`);
  }
}
function jsonFile(path, label) {
  assertFile(path, label);
  const source = readFileSync(path, 'utf8');
  try { return { source, value: JSON.parse(source) }; }
  catch { throw new Error(`${label.label} is invalid JSON.`); }
}
function parseOffsiteEnvironment(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\s'"\\]+)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) throw new Error('Backup offsite environment is invalid.');
    values[match[1]] = match[2];
  }
  // The contract comes from the policy module that validates these values just
  // below, so a new retention tier cannot leave this list behind again.
  if (Object.keys(values).sort().join('\0') !== OFFSITE_ENVIRONMENT_FIELDS.join('\0')) {
    throw new Error('Backup offsite environment fields do not match the approved contract.');
  }
  return values;
}
function parseBackupEnvironment(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\s'"\\]+)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) throw new Error('Production backup environment is invalid.');
    values[match[1]] = match[2];
  }
  const expected = [
    'DATABASE_URL', 'NODE_ENV', 'PAWSHOP_BACKUP_DIR', 'PAWSHOP_BACKUP_KEY_FILE',
    'PAWSHOP_INFRA_TOPOLOGY', 'PAWSHOP_MODE',
  ].sort();
  if (Object.keys(values).sort().join('\0') !== expected.join('\0')) {
    throw new Error('Production backup environment fields do not match the approved contract.');
  }
  validateProductionBackupEnvironment(values);
  return values;
}

const releaseManifestPath = join(release, '.pawshop-release.json');
const releaseManifest = jsonFile(releaseManifestPath,
  { uid: 0, gid: 0, mode: 0o644, label: 'Prepared release manifest', maximum: 64 * 1024 * 1024 }).value;
if (releaseManifest.release_id !== releaseId || releaseManifest.content_sha256 !== contentSha256) {
  throw new Error('Backup evidence is not bound to the verified prepared release.');
}

const evidenceDir = `/var/lib/pawshop-release-evidence/${releaseId}`;
const migrationPath = join(evidenceDir, 'migration.json');
const migration = jsonFile(migrationPath,
  { uid: 0, gid: 0, mode: 0o444, label: 'Migration evidence', maximum: 64 * 1024 });
assertMigrationEvidence(migration.value, releaseId);
if (migration.value.release_content_sha256 !== contentSha256) {
  throw new Error('Migration and backup candidates do not match.');
}

assertFile('/etc/pawshop/commerce.env', {
  uid: 0, gid: pawshopGid, mode: 0o640, label: 'Production commerce environment', maximum: 64 * 1024,
});
const commerceEnvironment = parseProductionEnvironmentFile(readFileSync('/etc/pawshop/commerce.env', 'utf8'));
const backupEnvironmentPath = '/etc/pawshop-backup/backup.env';
assertFile(backupEnvironmentPath, {
  uid: 0, gid: backupGid, mode: 0o640, label: 'Production backup environment', maximum: 64 * 1024,
});
const backupEnvironment = parseBackupEnvironment(readFileSync(backupEnvironmentPath, 'utf8'));
const commerceConnection = databaseConnection(commerceEnvironment.DATABASE_URL);
const backupConnection = databaseConnection(backupEnvironment.DATABASE_URL);
if (commerceConnection.host !== backupConnection.host || commerceConnection.port !== backupConnection.port ||
    commerceConnection.database !== backupConnection.database || backupConnection.database !== migration.value.database) {
  throw new Error('Production backup target does not match the exact migrated commerce database.');
}

const backupDir = '/var/backups/pawshop';
const manifestPath = join(backupDir, manifestName);
const manifest = jsonFile(manifestPath,
  { uid: backupUid, gid: backupGid, mode: 0o600, label: 'Production backup manifest', maximum: 64 * 1024 });
const { expectedEncrypted } = assertProductionBackupManifest(manifest.value, manifestName);
if (manifest.value.source_database !== migration.value.database ||
    manifest.value.source_database !== backupConnection.database) {
  throw new Error('Production backup manifest is not bound to the migrated commerce database.');
}
const encryptedPath = join(backupDir, expectedEncrypted);
assertFile(encryptedPath, {
  uid: backupUid, gid: backupGid, mode: 0o600, label: 'Encrypted production backup',
});
if (statSync(encryptedPath).size !== manifest.value.size_bytes ||
    !equalHex(await digestFile(encryptedPath), manifest.value.sha256)) {
  throw new Error('Encrypted production backup does not match its manifest.');
}
const backupKeyPath = '/etc/pawshop-backup/backup.key';
assertFile(backupKeyPath, { uid: 0, gid: backupGid, mode: 0o640, label: 'Production backup key', maximum: 1024 });
const backupKey = readBackupKey(backupKeyPath);
if (!equalHex(backupManifestHmac(manifest.value, backupKey), manifest.value.manifest_hmac_sha256)) {
  throw new Error('Production backup manifest authentication failed.');
}

const offsitePath = '/etc/pawshop-backup/backup-offsite.env';
assertFile(offsitePath, { uid: 0, gid: backupGid, mode: 0o640, label: 'Backup offsite environment', maximum: 16 * 1024 });
const offsite = validateOffsiteConfig(parseOffsiteEnvironment(readFileSync(offsitePath, 'utf8')), {
  accessKeyId: 'evidence-validation-key', secretAccessKey: 'evidence-validation-secret-value',
});
const receiptName = manifestName.replace(/\.manifest\.json$/, '.offsite.json');
const receiptPath = join(backupDir, receiptName);
const receipt = jsonFile(receiptPath,
  { uid: backupUid, gid: backupGid, mode: 0o600, label: 'Offsite backup receipt', maximum: 64 * 1024 }).value;
const manifestHash = await digestFile(manifestPath);
if (!offsiteReceiptIsValid(receipt, {
  manifest: manifest.value, manifestFile: manifestPath, manifestHash,
  bucket: offsite.bucket, backupKey,
})) throw new Error('Versioned offsite backup receipt is invalid.');

const verificationPath = join('/var/lib/pawshop-restore/verifications', verificationName);
const verification = jsonFile(verificationPath,
  { uid: restoreUid, gid: restoreGid, mode: 0o600, label: 'Isolated restore verification', maximum: 64 * 1024 });
assertRestoreVerification(verification.value, manifest.value);
const evidence = backupRestoreEvidence({
  releaseId, releaseContentSha256: contentSha256, migrationSource: migration.source,
  migrationSetSha256: migration.value.migration_set_sha256, backupManifestFile: manifestName,
  encryptedBackupSha256: manifest.value.sha256, restoreVerificationFile: basename(verificationPath),
  restoreVerificationSource: verification.source, restoreVerifiedAt: verification.value.verified_at,
});
assertBackupRestoreEvidence(evidence, releaseId);

const target = join(evidenceDir, 'backup-restore.json');
const temporary = `${target}.${process.pid}.tmp`;
const lockPath = join(evidenceDir, '.backup-restore.lock');
let lock;
try {
  lock = openSync(lockPath, 'wx', 0o600);
  if (existsSync(target)) throw new Error('Backup and restore evidence already exists and cannot be replaced.');
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  chmodSync(temporary, 0o400);
  renameSync(temporary, target);
  chmodSync(target, 0o444);
} finally {
  rmSync(temporary, { force: true });
  if (lock !== undefined) { closeSync(lock); rmSync(lockPath, { force: true }); }
}
console.log('Exact-release backup and isolated-restore evidence was recorded.');
