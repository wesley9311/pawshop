import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertRestoreVerification, backupRestoreEvidence } = require('./first-production-backup-evidence.cjs');
const { assertBackupRestoreEvidence, assertMigrationEvidence } = require('./release-evidence.cjs');
const { RELEASE_ID } = require('./release-manifest.cjs');
const { parseProductionEnvironmentFile } = require('./production-env-file.cjs');
const { databaseConnection } = require('./production-private-paths.cjs');
const {
  PRODUCTION_BACKUP_ENVIRONMENT_FILE, PRODUCTION_MANIFEST_FILE, parseProductionBackupEnvironment,
  verifyProductionBackupSet,
} = require('./production-backup-verification.cjs');

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
    !PRODUCTION_MANIFEST_FILE.test(manifestName || '') ||
    !/^verification-[0-9]+\.json$/.test(verificationName || '')) {
  throw new Error('Backup evidence arguments are invalid.');
}

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
// Either approved migration shape is accepted here; the database it names is what
// the backup has to have been taken from.
assertMigrationEvidence(migration.value, releaseId);
if (migration.value.release_content_sha256 !== contentSha256) {
  throw new Error('Migration and backup candidates do not match.');
}

assertFile('/etc/pawshop/commerce.env', {
  uid: 0, gid: pawshopGid, mode: 0o640, label: 'Production commerce environment', maximum: 64 * 1024,
});
const commerceEnvironment = parseProductionEnvironmentFile(readFileSync('/etc/pawshop/commerce.env', 'utf8'));
assertFile(PRODUCTION_BACKUP_ENVIRONMENT_FILE, {
  uid: 0, gid: backupGid, mode: 0o640, label: 'Production backup environment', maximum: 64 * 1024,
});
const backupEnvironment = parseProductionBackupEnvironment(readFileSync(PRODUCTION_BACKUP_ENVIRONMENT_FILE, 'utf8'));
const commerceConnection = databaseConnection(commerceEnvironment.DATABASE_URL);
const backupConnection = databaseConnection(backupEnvironment.DATABASE_URL);
if (commerceConnection.host !== backupConnection.host || commerceConnection.port !== backupConnection.port ||
    commerceConnection.database !== backupConnection.database || backupConnection.database !== migration.value.database) {
  throw new Error('Production backup target does not match the exact migrated commerce database.');
}

// The manifest, the encrypted dump and the offsite receipt are verified together
// by the module both evidence writers share, so this record and the pre-upgrade
// restore point cannot disagree about what a verified backup is.
const backup = await verifyProductionBackupSet({
  manifestName, expectedDatabase: migration.value.database,
});
if (backup.manifest.source_database !== migration.value.database ||
    backup.manifest.source_database !== backupConnection.database) {
  throw new Error('Production backup manifest is not bound to the migrated commerce database.');
}

const verificationPath = join('/var/lib/pawshop-restore/verifications', verificationName);
const verification = jsonFile(verificationPath,
  { uid: restoreUid, gid: restoreGid, mode: 0o600, label: 'Isolated restore verification', maximum: 64 * 1024 });
assertRestoreVerification(verification.value, backup.manifest);
const evidence = backupRestoreEvidence({
  releaseId, releaseContentSha256: contentSha256, migrationSource: migration.source,
  migrationSetSha256: migration.value.migration_set_sha256, backupManifestFile: manifestName,
  encryptedBackupSha256: backup.encryptedSha256, restoreVerificationFile: basename(verificationPath),
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
