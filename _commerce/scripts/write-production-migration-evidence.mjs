import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { migrationEvidence, migrationSet } = require('./first-production-migration.cjs');
const { RELEASE_ID } = require('./release-manifest.cjs');
const { assertMigrationEvidence } = require('./release-evidence.cjs');

if (process.platform !== 'linux' || process.getuid() !== 0) {
  throw new Error('Production migration evidence must be written by root on Linux.');
}
const release = resolve(process.argv[2] || '');
const releaseId = process.argv[3];
const contentSha256 = process.argv[4];
if (!RELEASE_ID.test(releaseId || '') || release !== `/srv/pawshop-commerce/releases/${releaseId}`) {
  throw new Error('Migration evidence requires an exact prepared release path.');
}
const releaseStat = lstatSync(release);
if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink() || releaseStat.uid !== 0 ||
    (releaseStat.mode & 0o777) !== 0o755) throw new Error('Prepared release root is unsafe.');
let manifest;
try { manifest = JSON.parse(readFileSync(join(release, '.pawshop-release.json'), 'utf8')); }
catch { throw new Error('Prepared release manifest is unavailable or invalid.'); }
if (manifest.release_id !== releaseId || manifest.content_sha256 !== contentSha256) {
  throw new Error('Migration evidence is not bound to the verified prepared release.');
}
const set = migrationSet(manifest);
const evidence = migrationEvidence({
  releaseId, releaseContentSha256: contentSha256,
  migrationSetSha256: set.sha256, completedAt: new Date().toISOString(),
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
const target = join(directory, 'migration.json');
const temporary = `${target}.${process.pid}.tmp`;
const lockFile = join(directory, '.migration.lock');
let lock;
try {
  lock = openSync(lockFile, 'wx', 0o600);
  if (existsSync(target)) throw new Error('Migration evidence already exists and cannot be replaced.');
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  chmodSync(temporary, 0o400);
  renameSync(temporary, target);
  chmodSync(target, 0o444);
} finally {
  rmSync(temporary, { force: true });
  if (lock !== undefined) {
    closeSync(lock);
    rmSync(lockFile, { force: true });
  }
}
console.log('Exact-release production migration evidence was recorded.');
