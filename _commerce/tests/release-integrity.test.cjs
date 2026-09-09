'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { releaseFiles, contentSha256, sha256, assertReleaseManifest } = require('../scripts/release-manifest.cjs');
const { assertMigrationEvidence, assertBackupRestoreEvidence } = require('../scripts/release-evidence.cjs');

test('prepared release manifest detects content, mode, and symlink-target tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'pawshop-release-'));
  try {
    mkdirSync(join(root, '_commerce'));
    writeFileSync(join(root, '_commerce/package-lock.json'), '{}\n');
    writeFileSync(join(root, '_commerce/app.js'), 'approved\n');
    symlinkSync('app.js', join(root, '_commerce/current.js'));
    const releaseId = 'a'.repeat(40);
    const treeId = 'b'.repeat(40);
    const files = releaseFiles(root);
    const manifest = {
      schema: 'pawshop-prepared-release-v1', release_id: releaseId, git_tree: treeId,
      package_lock_sha256: sha256(readFileSync(join(root, '_commerce/package-lock.json'))),
      content_sha256: contentSha256(files), files,
    };
    assert.doesNotThrow(() => assertReleaseManifest(manifest, {
      releaseId, treeId, packageLockSha256: manifest.package_lock_sha256, files: releaseFiles(root),
    }));
    writeFileSync(join(root, '_commerce/app.js'), 'tampered\n');
    assert.throws(() => assertReleaseManifest(manifest, {
      releaseId, treeId, packageLockSha256: manifest.package_lock_sha256, files: releaseFiles(root),
    }));
    writeFileSync(join(root, '_commerce/app.js'), 'approved\n');
    chmodSync(join(root, '_commerce/app.js'), 0o600);
    assert.throws(() => assertReleaseManifest(manifest, {
      releaseId, treeId, packageLockSha256: manifest.package_lock_sha256, files: releaseFiles(root),
    }));
    rmSync(join(root, '_commerce/current.js'));
    symlinkSync('package-lock.json', join(root, '_commerce/current.js'));
    assert.throws(() => assertReleaseManifest(manifest, {
      releaseId, treeId, packageLockSha256: manifest.package_lock_sha256, files: releaseFiles(root),
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release evidence contracts bind migration and restore to exact content', () => {
  const releaseId = 'a'.repeat(40);
  const digest = 'b'.repeat(64);
  const migrationSet = 'c'.repeat(64);
  const migration = {
    schema: 'pawshop-production-migration-v1', release_id: releaseId,
    release_content_sha256: digest, database: 'pawshop', initialization: 'empty-database',
    completed_at: '2026-09-09T00:00:00.000Z', command: 'db:migrate',
    migration_set_sha256: migrationSet, status: 'succeeded',
  };
  const restored = {
    schema: 'pawshop-production-backup-restore-v1', release_id: releaseId,
    release_content_sha256: digest, migration_receipt_sha256: 'd'.repeat(64),
    migration_set_sha256: migrationSet, backup_manifest_file: 'backup.manifest.json',
    encrypted_backup_sha256: 'e'.repeat(64), restore_verification_file: 'restore.json',
    restore_verification_sha256: 'f'.repeat(64), restore_verified_at: '2026-09-09T00:05:00.000Z',
    isolated_cluster_removed: true, status: 'succeeded',
  };
  assert.doesNotThrow(() => assertMigrationEvidence(migration, releaseId));
  assert.doesNotThrow(() => assertBackupRestoreEvidence(restored, releaseId));
  assert.throws(() => assertMigrationEvidence({ ...migration, release_id: '0'.repeat(40) }, releaseId));
  assert.throws(() => assertBackupRestoreEvidence({ ...restored, migration_set_sha256: 'nope' }, releaseId));
});
