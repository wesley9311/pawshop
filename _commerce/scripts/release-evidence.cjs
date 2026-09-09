'use strict';

const RELEASE_ID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

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

function assertMigrationEvidence(value, releaseId) {
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

module.exports = { assertMigrationEvidence, assertBackupRestoreEvidence };
