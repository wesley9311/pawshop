import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { assertMigrationEvidence, assertBackupRestoreEvidence } = require('./release-evidence.cjs');

const releaseId = process.argv[2];
const releaseContentSha256 = process.argv[3];
if (!/^[0-9a-f]{40}$/.test(releaseId || '')) throw new Error('A full release ID is required for evidence verification.');
if (!/^[0-9a-f]{64}$/.test(releaseContentSha256 || '')) throw new Error('The verified release content digest is required.');
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

const migrationFile = join(directory, 'migration.json');
const backupRestoreFile = join(directory, 'backup-restore.json');
assertStat(migrationFile, 0o444, 'Migration evidence');
assertStat(backupRestoreFile, 0o444, 'Backup and restore evidence');

const parse = (path, label) => {
  const source = readFileSync(path, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > 16 * 1024 || source.includes('\0')) {
    throw new Error(`${label} has an unsafe format.`);
  }
  try { return JSON.parse(source); } catch { throw new Error(`${label} is not valid JSON.`); }
};
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
