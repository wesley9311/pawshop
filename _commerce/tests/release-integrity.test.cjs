'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { releaseFiles, contentSha256, sha256, assertReleaseManifest } = require('../scripts/release-manifest.cjs');
const { assertMigrationEvidence, assertBackupRestoreEvidence } = require('../scripts/release-evidence.cjs');
const { migrationEvidence, migrationSet } = require('../scripts/first-production-migration.cjs');
const {
  assertRelationsPreserved, parseRelationsSnapshot, relationsDigest, serializeRelations,
  upgradeMigrationEvidence,
} = require('../scripts/production-upgrade-evidence.cjs');
const {
  assertRestoreVerification, backupRestoreEvidence,
} = require('../scripts/first-production-backup-evidence.cjs');

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

test('migration set digest is deterministic and evidence stays exact-release bound', () => {
  const manifest = {
    schema: 'pawshop-prepared-release-v1', release_id: 'a'.repeat(40),
    files: [
      { path: '_commerce/node_modules/pkg/migrations/002.js', type: 'file', sha256: '2'.repeat(64) },
      { path: '_commerce/README.md', type: 'file', sha256: '9'.repeat(64) },
      { path: '_commerce/node_modules/pkg/migrations/001.js', type: 'file', sha256: '1'.repeat(64) },
    ],
  };
  const first = migrationSet(manifest);
  const second = migrationSet({ ...manifest, files: [...manifest.files].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(first.entries.map(entry => entry.path), [
    '_commerce/node_modules/pkg/migrations/001.js',
    '_commerce/node_modules/pkg/migrations/002.js',
  ]);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  const evidence = migrationEvidence({
    releaseId: manifest.release_id, releaseContentSha256: 'b'.repeat(64),
    migrationSetSha256: first.sha256, completedAt: '2026-09-14T00:00:00.000Z',
  });
  assert.doesNotThrow(() => assertMigrationEvidence(evidence, manifest.release_id));
  assert.throws(() => migrationSet({ ...manifest, files: [] }));
  assert.throws(() => migrationEvidence({ ...evidence, releaseId: 'bad' }));
});

test('backup evidence binds exact migration bytes and isolated restore bytes', () => {
  const manifest = {
    source_database: 'pawshop', sha256: 'e'.repeat(64),
  };
  const verification = {
    schema: 'pawshop-production-restore-verification-v1',
    verified_at: '2026-09-14T00:05:00.000Z', source_database: 'pawshop',
    encrypted_backup_sha256: manifest.sha256,
    critical_table_counts: {
      customers: 0, images: 0, orders: 0, owner_users: 0, products: 0, variants: 0,
    },
    isolated_cluster_removed: true,
  };
  assert.doesNotThrow(() => assertRestoreVerification(verification, manifest));
  assert.throws(() => assertRestoreVerification({ ...verification, isolated_cluster_removed: false }, manifest));
  const migrationSource = '{"migration":"exact"}\n';
  const restoreSource = `${JSON.stringify(verification)}\n`;
  const evidence = backupRestoreEvidence({
    releaseId: 'a'.repeat(40), releaseContentSha256: 'b'.repeat(64),
    migrationSource, migrationSetSha256: 'c'.repeat(64),
    backupManifestFile: 'pawshop_production_20260914T000000000Z.manifest.json',
    encryptedBackupSha256: manifest.sha256,
    restoreVerificationFile: 'verification-1.json', restoreVerificationSource: restoreSource,
    restoreVerifiedAt: verification.verified_at,
  });
  assert.doesNotThrow(() => assertBackupRestoreEvidence(evidence, 'a'.repeat(40)));
  assert.notEqual(evidence.migration_receipt_sha256,
    backupRestoreEvidence({ ...{
      releaseId: 'a'.repeat(40), releaseContentSha256: 'b'.repeat(64),
      migrationSource: `${migrationSource} `, migrationSetSha256: 'c'.repeat(64),
      backupManifestFile: 'pawshop_production_20260914T000000000Z.manifest.json',
      encryptedBackupSha256: manifest.sha256,
      restoreVerificationFile: 'verification-1.json', restoreVerificationSource: restoreSource,
      restoreVerifiedAt: verification.verified_at,
    } }).migration_receipt_sha256);
});

test('an upgrade record is bound to the release it upgrades and to its restore point', () => {
  const releaseId = 'a'.repeat(40);
  const predecessor = 'b'.repeat(40);
  const before = [
    { schema: 'public', table: 'customer', rows: 4 },
    { schema: 'public', table: 'product', rows: 9 },
  ];
  const after = [...before, { schema: 'public', table: 'order', rows: 0 }];
  const inputs = {
    releaseId, releaseContentSha256: 'c'.repeat(64), migrationSetSha256: 'd'.repeat(64),
    completedAt: '2026-09-18T00:00:00.000Z', predecessorReleaseId: predecessor,
    preUpgradeBackupManifestFile: 'pawshop_production_20260918T000000000Z.manifest.json',
    preUpgradeBackupSha256: 'e'.repeat(64), relationsBefore: before, relationsAfter: after,
  };
  const evidence = upgradeMigrationEvidence(inputs);
  assert.doesNotThrow(() => assertMigrationEvidence(evidence, releaseId));
  assert.equal(evidence.initialization, 'existing-database');
  assert.equal(evidence.predecessor_release_id, predecessor);
  assert.equal(evidence.tables_before, 2);
  assert.equal(evidence.tables_after, 3);
  // An upgrade record is not evidence for any other release, and it may not
  // describe itself as a first activation of an empty database.
  assert.throws(() => assertMigrationEvidence(evidence, predecessor));
  assert.throws(() => assertMigrationEvidence({ ...evidence, initialization: 'empty-database' }, releaseId));
  assert.throws(() => assertMigrationEvidence({ ...evidence, schema: 'pawshop-production-migration-v1' }, releaseId));
  // The release it upgrades has to exist and has to be a different release.
  assert.throws(() => upgradeMigrationEvidence({ ...inputs, predecessorReleaseId: releaseId }));
  assert.throws(() => upgradeMigrationEvidence({ ...inputs, predecessorReleaseId: 'not-a-sha' }));
  // A missing or malformed restore point is refused.
  assert.throws(() => upgradeMigrationEvidence({ ...inputs, preUpgradeBackupManifestFile: 'backup.manifest.json' }));
  assert.throws(() => upgradeMigrationEvidence({ ...inputs, preUpgradeBackupSha256: 'nope' }));
  // Data has to survive: a relation that loses rows, or disappears, fails the
  // record before any evidence is produced.
  assert.throws(() => upgradeMigrationEvidence({ ...inputs, relationsAfter: [after[0]] }));
  assert.throws(() => upgradeMigrationEvidence({
    ...inputs, relationsAfter: [{ schema: 'public', table: 'customer', rows: 3 }, after[1]],
  }));
  assert.throws(() => upgradeMigrationEvidence({ ...inputs, relationsBefore: [], relationsAfter: after }));
});

test('relation snapshots are canonical and reproducible from the stored bytes', () => {
  const parsed = parseRelationsSnapshot(JSON.stringify([
    { schema: 'public', table: 'product', rows: 2 },
    { schema: 'public', table: 'customer', rows: 0 },
  ]));
  assert.deepEqual(parsed.map(entry => entry.table), ['customer', 'product']);
  // The recorded digest is the digest of the bytes kept as evidence, so an
  // auditor can reproduce it with sha256sum on the stored snapshot.
  assert.equal(relationsDigest(parsed),
    createHash('sha256').update(serializeRelations(parsed)).digest('hex'));
  assert.equal(serializeRelations(parsed), `${JSON.stringify(parsed, null, 2)}\n`);
  assert.throws(() => parseRelationsSnapshot('[]'));
  assert.throws(() => parseRelationsSnapshot('not json'));
  assert.throws(() => parseRelationsSnapshot(JSON.stringify([
    { schema: 'public', table: 'product', rows: 2 },
    { schema: 'public', table: 'product', rows: 2 },
  ])));
  assert.throws(() => parseRelationsSnapshot(JSON.stringify([{ schema: 'public', table: 'product', rows: -1 }])));
  assert.throws(() => parseRelationsSnapshot(JSON.stringify([{ schema: 'public', table: 'product' }])));
  assert.throws(() => parseRelationsSnapshot(JSON.stringify([{ schema: 'public', table: 'a b', rows: 1 }])));
  assert.doesNotThrow(() => assertRelationsPreserved(parsed, parsed));
  assert.throws(() => assertRelationsPreserved(parsed, [parsed[1]]));
});
