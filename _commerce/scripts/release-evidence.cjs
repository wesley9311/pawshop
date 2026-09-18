'use strict';

const { PRODUCTION_MANIFEST_FILE } = require('./production-backup-verification.cjs');

const RELEASE_ID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;
const UPGRADE_MIGRATION_SCHEMA = 'pawshop-production-migration-v2';

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw new Error(`${label} fields do not match the approved evidence contract.`);
  }
}

function isoTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      Number.isNaN(Date.parse(value))) throw new Error(`${label} timestamp is invalid.`);
}

// Two shapes are approved, and the shape is the mode. `empty-database` is the
// first activation of a fresh production database. `existing-database` is every
// activation after that: the same release binding, plus the release it upgrades,
// the restore point that predates the schema change, and the relation snapshot
// that shows the data survived. Keeping them as separate schemas rather than one
// schema with optional fields means an upgrade can never be graded by the weaker
// first-activation rules, and the checks below are the only difference between
// them.
function assertUpgradeMigrationEvidence(value, releaseId) {
  exactKeys(value, [
    'schema', 'release_id', 'release_content_sha256', 'database', 'initialization',
    'predecessor_release_id', 'pre_upgrade_backup_manifest_file', 'pre_upgrade_backup_sha256',
    'relations_before_sha256', 'relations_after_sha256', 'tables_before', 'tables_after',
    'completed_at', 'command', 'migration_set_sha256', 'status',
  ], 'Migration');
  if (!RELEASE_ID.test(releaseId) || value.schema !== UPGRADE_MIGRATION_SCHEMA ||
      value.release_id !== releaseId || value.database !== 'pawshop' ||
      value.initialization !== 'existing-database' || value.command !== 'db:migrate' ||
      !SHA256.test(value.release_content_sha256) || !SHA256.test(value.migration_set_sha256) ||
      !SHA256.test(value.pre_upgrade_backup_sha256) ||
      !SHA256.test(value.relations_before_sha256) || !SHA256.test(value.relations_after_sha256) ||
      !PRODUCTION_MANIFEST_FILE.test(value.pre_upgrade_backup_manifest_file || '') ||
      !RELEASE_ID.test(value.predecessor_release_id || '') ||
      value.predecessor_release_id === releaseId ||
      !Number.isSafeInteger(value.tables_before) || value.tables_before < 1 ||
      !Number.isSafeInteger(value.tables_after) || value.tables_after < value.tables_before ||
      value.status !== 'succeeded') {
    throw new Error('Upgrade migration evidence is not approved for this exact release.');
  }
  isoTimestamp(value.completed_at, 'Migration completion');
}

function assertMigrationEvidence(value, releaseId) {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      value.schema === UPGRADE_MIGRATION_SCHEMA) {
    assertUpgradeMigrationEvidence(value, releaseId);
    return;
  }
  exactKeys(value, [
    'schema', 'release_id', 'release_content_sha256', 'database', 'initialization',
    'completed_at', 'command', 'migration_set_sha256', 'status',
  ], 'Migration');
  if (!RELEASE_ID.test(releaseId) || value.schema !== 'pawshop-production-migration-v1' ||
      value.release_id !== releaseId || value.database !== 'pawshop' ||
      value.initialization !== 'empty-database' || value.command !== 'db:migrate' ||
      !SHA256.test(value.release_content_sha256) || !SHA256.test(value.migration_set_sha256) ||
      value.status !== 'succeeded') throw new Error('Migration evidence is not approved for this exact release.');
  isoTimestamp(value.completed_at, 'Migration completion');
}

function assertBackupRestoreEvidence(value, releaseId) {
  exactKeys(value, [
    'schema', 'release_id', 'release_content_sha256', 'migration_receipt_sha256',
    'migration_set_sha256', 'backup_manifest_file', 'encrypted_backup_sha256',
    'restore_verification_file', 'restore_verification_sha256', 'restore_verified_at',
    'isolated_cluster_removed', 'status',
  ], 'Backup and restore');
  if (!RELEASE_ID.test(releaseId) || value.schema !== 'pawshop-production-backup-restore-v1' ||
      value.release_id !== releaseId || !SAFE_FILE.test(value.backup_manifest_file) ||
      !SHA256.test(value.release_content_sha256) || !SHA256.test(value.migration_receipt_sha256) ||
      !SHA256.test(value.migration_set_sha256) || !SHA256.test(value.encrypted_backup_sha256) ||
      !SAFE_FILE.test(value.restore_verification_file) || !SHA256.test(value.restore_verification_sha256) ||
      value.isolated_cluster_removed !== true || value.status !== 'succeeded') {
    throw new Error('Backup and restore evidence is not approved for this exact release.');
  }
  isoTimestamp(value.restore_verified_at, 'Restore verification');
}

module.exports = { assertMigrationEvidence, assertUpgradeMigrationEvidence, assertBackupRestoreEvidence };
