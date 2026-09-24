import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { migrationSet } = require('./first-production-migration.cjs');
const { assertReleaseManifest, releaseFiles, sha256: fileSha256 } = require('./release-manifest.cjs');
const { assertCodeOnlyEvidence, codeOnlyEvidence, sha256 } = require('./code-only-release.cjs');

if (process.platform !== 'linux' || process.getuid() !== 0) {
  throw new Error('Code-only production evidence must be written by root on Linux.');
}
const source = resolve(process.argv[2] || '');
const release = resolve(process.argv[3] || '');
const releaseId = process.argv[4];
const releaseContentSha256 = process.argv[5];
const predecessor = resolve(process.argv[6] || '');
const predecessorReleaseId = process.argv[7];
const predecessorContentSha256 = process.argv[8];
if (source !== '/srv/pawshop-source' || release !== `/srv/pawshop-commerce/releases/${releaseId}` ||
    predecessor !== `/srv/pawshop-commerce/releases/${predecessorReleaseId}`) {
  throw new Error('Code-only evidence requires fixed production source and release paths.');
}

function manifestFor(root, expectedId, expectedContent) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o755) {
    throw new Error('Code-only release root is unsafe.');
  }
  const manifest = JSON.parse(readFileSync(join(root, '.pawshop-release.json'), 'utf8'));
  assertReleaseManifest(manifest, {
    releaseId: expectedId,
    treeId: manifest.git_tree,
    packageLockSha256: fileSha256(readFileSync(join(root, '_commerce/package-lock.json'))),
    files: releaseFiles(root),
  });
  if (manifest.content_sha256 !== expectedContent) throw new Error('Code-only release digest does not match its manifest.');
  return manifest;
}

const candidateManifest = manifestFor(release, releaseId, releaseContentSha256);
const predecessorManifest = manifestFor(predecessor, predecessorReleaseId, predecessorContentSha256);
const candidateMigrations = migrationSet(candidateManifest);
const predecessorMigrations = migrationSet(predecessorManifest);
if (candidateMigrations.sha256 !== predecessorMigrations.sha256) {
  throw new Error('Code-only release refused because the prepared migration set changed.');
}

function git(args, encoding = 'buffer') {
  const result = spawnSync('/usr/bin/git', [
    '-c', `safe.directory=${source}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-C', source, ...args,
  ], { encoding, env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' }, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || result.stderr.length) throw new Error('Could not inspect the exact code-only Git diff.');
  return result.stdout;
}
for (const id of [releaseId, predecessorReleaseId]) {
  if (git(['rev-parse', '--verify', `${id}^{commit}`], 'utf8').trim() !== id) {
    throw new Error('Code-only diff endpoint is not an exact commit.');
  }
}
const paths = git(['diff', '--name-only', '-z', predecessorReleaseId, releaseId, '--', '_commerce', 'ops/commerce'])
  .toString('utf8').split('\0').filter(Boolean).sort();
const diff = git(['diff', '--binary', '--full-index', predecessorReleaseId, releaseId, '--', '_commerce', 'ops/commerce']);
if (diff.length < 1 || diff.length > 32 * 1024 * 1024) throw new Error('Code-only diff is empty or too large.');
const evidence = codeOnlyEvidence({
  releaseId, releaseContentSha256, predecessorReleaseId, predecessorContentSha256,
  migrationSetSha256: candidateMigrations.sha256, diffSha256: sha256(diff), changedPaths: paths,
  capturedAt: new Date().toISOString(),
});
assertCodeOnlyEvidence(evidence, {
  releaseId, releaseContentSha256, predecessorReleaseId, predecessorContentSha256,
  migrationSetSha256: candidateMigrations.sha256, diffSha256: sha256(diff), changedPaths: paths,
});

const evidenceRoot = '/var/lib/pawshop-release-evidence';
const directory = join(evidenceRoot, releaseId);
mkdirSync(evidenceRoot, { mode: 0o700, recursive: true });
mkdirSync(directory, { mode: 0o700, recursive: true });
for (const path of [evidenceRoot, directory]) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 ||
      (stat.mode & 0o777) !== 0o700) throw new Error('Code-only evidence directory is unsafe.');
}
for (const incompatible of ['migration.json', 'backup-restore.json']) {
  if (existsSync(join(directory, incompatible))) throw new Error('Migration evidence cannot be mixed with code-only evidence.');
}
const target = join(directory, 'code-only.json');
const temporary = `${target}.${process.pid}.tmp`;
const lockPath = join(directory, '.code-only.lock');
let lock;
try {
  lock = openSync(lockPath, 'wx', 0o600);
  if (existsSync(target)) throw new Error('Code-only evidence already exists and cannot be replaced.');
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  chmodSync(temporary, 0o400);
  renameSync(temporary, target);
  chmodSync(target, 0o444);
} finally {
  rmSync(temporary, { force: true });
  if (lock !== undefined) { closeSync(lock); rmSync(lockPath, { force: true }); }
}
console.log(`Code-only evidence recorded for ${predecessorReleaseId} -> ${releaseId}.`);
