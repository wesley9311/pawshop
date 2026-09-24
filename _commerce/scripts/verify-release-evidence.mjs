import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { assertMigrationEvidence, assertBackupRestoreEvidence } = require('./release-evidence.cjs');
const { assertCodeOnlyEvidence, sha256 } = require('./code-only-release.cjs');
const { migrationSet } = require('./first-production-migration.cjs');

const releaseId = process.argv[2];
const releaseContentSha256 = process.argv[3];
const mode = process.argv[4] || 'standard';
const predecessorReleaseId = process.argv[5];
const predecessorContentSha256 = process.argv[6];
const sourceDirectory = process.argv[7];
const candidateDirectory = process.argv[8];
const predecessorDirectory = process.argv[9];
if (!/^[0-9a-f]{40}$/.test(releaseId || '')) throw new Error('A full release ID is required for evidence verification.');
if (!/^[0-9a-f]{64}$/.test(releaseContentSha256 || '')) throw new Error('The verified release content digest is required.');
if (!['standard', 'code-only'].includes(mode)) throw new Error('Release evidence mode is invalid.');
const root = '/var/lib/pawshop-release-evidence';
const directory = join(root, releaseId);

function assertStat(path, expectedMode, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 ||
      (stat.mode & 0o777) !== expectedMode) throw new Error(`${label} has unsafe ownership, type, or permissions.`);
}

for (const [path, label] of [[root, 'Evidence root'], [directory, 'Release evidence directory']]) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 ||
      (stat.mode & 0o777) !== 0o700) throw new Error(`${label} has unsafe ownership, type, or permissions.`);
}

const parse = (path, label, maximum = 16 * 1024) => {
  const source = readFileSync(path, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > maximum || source.includes('\0')) {
    throw new Error(`${label} has an unsafe format.`);
  }
  try { return JSON.parse(source); } catch { throw new Error(`${label} is not valid JSON.`); }
};
if (mode === 'code-only') {
  if (!/^[0-9a-f]{40}$/.test(predecessorReleaseId || '') ||
      !/^[0-9a-f]{64}$/.test(predecessorContentSha256 || '')) {
    throw new Error('Code-only verification requires the exact active predecessor identity.');
  }
  for (const incompatible of ['migration.json', 'backup-restore.json']) {
    if (existsSync(join(directory, incompatible))) {
      throw new Error('Code-only evidence cannot be mixed with migration or restore evidence.');
    }
  }
  const codeOnlyFile = join(directory, 'code-only.json');
  assertStat(codeOnlyFile, 0o444, 'Code-only evidence');
  const evidence = parse(codeOnlyFile, 'Code-only evidence', 2 * 1024 * 1024);
  if (sourceDirectory !== '/srv/pawshop-source' ||
      candidateDirectory !== `/srv/pawshop-commerce/releases/${releaseId}` ||
      predecessorDirectory !== `/srv/pawshop-commerce/releases/${predecessorReleaseId}`) {
    throw new Error('Code-only verification requires fixed production paths.');
  }
  const candidateManifest = parse(join(candidateDirectory, '.pawshop-release.json'), 'Candidate release manifest', 64 * 1024 * 1024);
  const predecessorManifest = parse(join(predecessorDirectory, '.pawshop-release.json'), 'Predecessor release manifest', 64 * 1024 * 1024);
  const candidateMigrations = migrationSet(candidateManifest);
  const predecessorMigrations = migrationSet(predecessorManifest);
  if (candidateMigrations.sha256 !== predecessorMigrations.sha256) {
    throw new Error('Code-only verification refused a changed migration set.');
  }
  const git = args => {
    const result = spawnSync('/usr/bin/git', [
      '-c', `safe.directory=${sourceDirectory}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-C', sourceDirectory, ...args,
    ], { encoding: 'buffer', env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' }, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0 || result.stderr.length) throw new Error('Could not independently verify the code-only Git diff.');
    return result.stdout;
  };
  const changedPaths = git(['diff', '--name-only', '-z', predecessorReleaseId, releaseId, '--', '_commerce', 'ops/commerce'])
    .toString('utf8').split('\0').filter(Boolean).sort();
  const diff = git(['diff', '--binary', '--full-index', predecessorReleaseId, releaseId, '--', '_commerce', 'ops/commerce']);
  assertCodeOnlyEvidence(evidence, {
    releaseId, releaseContentSha256, predecessorReleaseId, predecessorContentSha256,
    migrationSetSha256: candidateMigrations.sha256, diffSha256: sha256(diff), changedPaths,
  });
  console.log(`Code-only release evidence verified for ${predecessorReleaseId} -> ${releaseId}.`);
  process.exit(0);
}

if (existsSync(join(directory, 'code-only.json'))) {
  throw new Error('Standard release evidence cannot be mixed with code-only evidence.');
}
const migrationFile = join(directory, 'migration.json');
const backupRestoreFile = join(directory, 'backup-restore.json');
assertStat(migrationFile, 0o444, 'Migration evidence');
assertStat(backupRestoreFile, 0o444, 'Backup and restore evidence');
const migrationSource = readFileSync(migrationFile, 'utf8');
const migration = parse(migrationFile, 'Migration evidence');
const backupRestore = parse(backupRestoreFile, 'Backup and restore evidence');
assertMigrationEvidence(migration, releaseId);
assertBackupRestoreEvidence(backupRestore, releaseId);
if (migration.release_content_sha256 !== releaseContentSha256 ||
    backupRestore.release_content_sha256 !== releaseContentSha256 ||
    backupRestore.migration_set_sha256 !== migration.migration_set_sha256 ||
    backupRestore.migration_receipt_sha256 !== createHash('sha256').update(migrationSource).digest('hex')) {
  throw new Error('Release evidence chain does not bind to the verified candidate and migration receipt.');
}
console.log(`Release evidence verified for ${releaseId}.`);
