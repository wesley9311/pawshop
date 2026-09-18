// Records the evidence for an upgrade of a production database that already
// holds data, as the counterpart of write-production-migration-evidence.mjs.
//
// Everything here is checked before anything is written, because a half-recorded
// upgrade is worse than a refused one: the activation gate reads this file and
// nothing else. The order matters too - the restore point has to be verified as
// intact, offsite, and *recent*, because an old dump that merely looks
// restorable is not a restore point for this upgrade.

import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertMigrationEvidence } = require('./release-evidence.cjs');
const { RELEASE_ID } = require('./release-manifest.cjs');
const { migrationSet } = require('./first-production-migration.cjs');
const { parseProductionEnvironmentFile } = require('./production-env-file.cjs');
const { databaseConnection } = require('./production-private-paths.cjs');
const {
  PRODUCTION_BACKUP_ENVIRONMENT_FILE, PRODUCTION_MANIFEST_FILE, assertPrivateFile,
  backupServiceIds, parseProductionBackupEnvironment, verifyProductionBackupSet,
} = require('./production-backup-verification.cjs');
const {
  parseRelationsSnapshot, serializeRelations, upgradeMigrationEvidence,
} = require('./production-upgrade-evidence.cjs');

const SNAPSHOT_DIRECTORY = '/run/pawshop-upgrade';
const SNAPSHOT_NAME = /^(before|after)-[0-9a-zA-Z]{1,64}\.json$/;
// The restore point must belong to this upgrade window. Thirty minutes is far
// longer than the few seconds between taking the backup and opening the window,
// and far shorter than any interval in which the dump stops representing the
// data being changed.
const MAXIMUM_RESTORE_POINT_AGE_MS = 30 * 60 * 1000;

if (process.platform !== 'linux' || process.getuid() !== 0) {
  throw new Error('Production upgrade evidence must be written by root on Linux.');
}
if (process.argv.length !== 9) {
  throw new Error('Usage: write-production-upgrade-evidence.mjs RELEASE RELEASE_ID CONTENT_SHA256 PREDECESSOR_RELEASE_ID PRE_UPGRADE_MANIFEST BEFORE_SNAPSHOT AFTER_SNAPSHOT');
}
const release = resolve(process.argv[2] || '');
const releaseId = process.argv[3];
const contentSha256 = process.argv[4];
const predecessorReleaseId = process.argv[5];
const preUpgradeManifest = process.argv[6];
const beforePath = resolve(process.argv[7] || '');
const afterPath = resolve(process.argv[8] || '');
if (!RELEASE_ID.test(releaseId || '') || !/^[0-9a-f]{64}$/.test(contentSha256 || '') ||
    release !== `/srv/pawshop-commerce/releases/${releaseId}` ||
    !RELEASE_ID.test(predecessorReleaseId || '') || predecessorReleaseId === releaseId ||
    !PRODUCTION_MANIFEST_FILE.test(preUpgradeManifest || '')) {
  throw new Error('Upgrade evidence arguments are invalid.');
}
for (const [path, label] of [[beforePath, 'Before snapshot'], [afterPath, 'After snapshot']]) {
  if (dirname(path) !== SNAPSHOT_DIRECTORY || !SNAPSHOT_NAME.test(basename(path))) {
    throw new Error(`${label} must come from the private upgrade window directory.`);
  }
}

const releaseStat = lstatSync(release);
if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink() || releaseStat.uid !== 0 ||
    (releaseStat.mode & 0o777) !== 0o755) throw new Error('Prepared release root is unsafe.');
let manifest;
try { manifest = JSON.parse(readFileSync(join(release, '.pawshop-release.json'), 'utf8')); }
catch { throw new Error('Prepared release manifest is unavailable or invalid.'); }
if (manifest.release_id !== releaseId || manifest.content_sha256 !== contentSha256) {
  throw new Error('Upgrade evidence is not bound to the verified prepared release.');
}

const { gid: backupGid } = backupServiceIds();
function snapshot(path, label) {
  const stat = assertPrivateFile(path, {
    uid: 0, gid: 0, mode: 0o600, label, maximum: 4 * 1024 * 1024,
  });
  return { entries: parseRelationsSnapshot(readFileSync(path, 'utf8')), mtimeMs: stat.mtimeMs };
}
const before = snapshot(beforePath, 'Before snapshot');
const after = snapshot(afterPath, 'After snapshot');

const pawshopGid = Number(execFileSync('/usr/bin/id', ['-g', 'pawshop'], { encoding: 'utf8' }).trim());
assertPrivateFile('/etc/pawshop/commerce.env', {
  uid: 0, gid: pawshopGid, mode: 0o640, label: 'Production commerce environment', maximum: 64 * 1024,
});
assertPrivateFile(PRODUCTION_BACKUP_ENVIRONMENT_FILE, {
  uid: 0, gid: backupGid, mode: 0o640, label: 'Production backup environment', maximum: 64 * 1024,
});
const commerceConnection = databaseConnection(
  parseProductionEnvironmentFile(readFileSync('/etc/pawshop/commerce.env', 'utf8')).DATABASE_URL);
const backupConnection = databaseConnection(
  parseProductionBackupEnvironment(readFileSync(PRODUCTION_BACKUP_ENVIRONMENT_FILE, 'utf8')).DATABASE_URL);
if (commerceConnection.host !== backupConnection.host || commerceConnection.port !== backupConnection.port ||
    commerceConnection.database !== backupConnection.database) {
  throw new Error('Production backup target does not match the exact commerce database being upgraded.');
}
// The approved record names the production database, and so do the deployment
// scripts (`--dbname pawshop`). Comparing against that name here means a
// renamed database cannot be silently recorded under the old one.
if (commerceConnection.database !== 'pawshop') {
  throw new Error('Upgrade evidence covers the pawshop production database only.');
}

const restorePoint = await verifyProductionBackupSet({
  manifestName: preUpgradeManifest, expectedDatabase: commerceConnection.database,
});
const createdAtMs = Date.parse(restorePoint.manifest.created_at);
if (!Number.isSafeInteger(createdAtMs) || createdAtMs > before.mtimeMs) {
  throw new Error('The pre-upgrade restore point was not taken before the upgrade window opened.');
}
if (before.mtimeMs - createdAtMs > MAXIMUM_RESTORE_POINT_AGE_MS) {
  throw new Error('The pre-upgrade restore point is too old to be the restore point for this upgrade.');
}

const evidence = upgradeMigrationEvidence({
  releaseId, releaseContentSha256: contentSha256,
  migrationSetSha256: migrationSet(manifest).sha256,
  completedAt: new Date().toISOString(),
  predecessorReleaseId,
  preUpgradeBackupManifestFile: preUpgradeManifest,
  preUpgradeBackupSha256: restorePoint.encryptedSha256,
  relationsBefore: before.entries,
  relationsAfter: after.entries,
});
assertMigrationEvidence(evidence, releaseId);

const evidenceRoot = '/var/lib/pawshop-release-evidence';
const directory = join(evidenceRoot, releaseId);
mkdirSync(evidenceRoot, { mode: 0o700, recursive: true });
mkdirSync(directory, { mode: 0o700, recursive: true });
for (const path of [evidenceRoot, directory]) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 ||
      (stat.mode & 0o777) !== 0o700) throw new Error('Release evidence directory is unsafe.');
}
const receiptPath = join(directory, 'migration.json');
for (const path of [receiptPath, join(directory, 'relations-before.json'), join(directory, 'relations-after.json')]) {
  if (existsSync(path)) throw new Error('Release evidence already exists and cannot be replaced.');
}
function publish(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o400);
    renameSync(temporary, path);
    chmodSync(path, 0o444);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
const lockPath = join(directory, '.upgrade-evidence.lock');
let lock;
try {
  lock = openSync(lockPath, 'wx', 0o600);
  publish(join(directory, 'relations-before.json'), serializeRelations(before.entries));
  publish(join(directory, 'relations-after.json'), serializeRelations(after.entries));
  publish(receiptPath, `${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  if (lock !== undefined) {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}
console.log(`Upgrade evidence recorded for ${releaseId} from ${predecessorReleaseId}: ` +
  `${evidence.tables_before} relations before, ${evidence.tables_after} after.`);
