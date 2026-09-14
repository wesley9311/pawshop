'use strict';

const { createHash } = require('node:crypto');

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function assertRestoreVerification(value, manifest) {
  const expected = [
    'schema', 'verified_at', 'source_database', 'encrypted_backup_sha256',
    'critical_table_counts', 'isolated_cluster_removed',
  ].sort();
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== expected.join('\0') ||
      value.schema !== 'pawshop-production-restore-verification-v1' ||
      value.source_database !== manifest.source_database ||
      value.encrypted_backup_sha256 !== manifest.sha256 ||
      value.isolated_cluster_removed !== true ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.verified_at || '') ||
      Number.isNaN(Date.parse(value.verified_at))) {
    throw new Error('Isolated restore verification does not match the production backup.');
  }
  const countKeys = ['customers', 'images', 'orders', 'owner_users', 'products', 'variants'];
  const counts = value.critical_table_counts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
      Object.keys(counts).sort().join('\0') !== countKeys.join('\0') ||
      Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error('Isolated restore verification has invalid critical table counts.');
  }
  return value;
}

function backupRestoreEvidence({
  releaseId, releaseContentSha256, migrationSource, migrationSetSha256,
  backupManifestFile, encryptedBackupSha256, restoreVerificationFile,
  restoreVerificationSource, restoreVerifiedAt,
}) {
  if (!/^[0-9a-f]{40}$/.test(releaseId || '') || !SHA256.test(releaseContentSha256 || '') ||
      !SHA256.test(migrationSetSha256 || '') || !SAFE_FILE.test(backupManifestFile || '') ||
      !SHA256.test(encryptedBackupSha256 || '') || !SAFE_FILE.test(restoreVerificationFile || '') ||
      typeof migrationSource !== 'string' || typeof restoreVerificationSource !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(restoreVerifiedAt || '') ||
      Number.isNaN(Date.parse(restoreVerifiedAt))) {
    throw new Error('Backup and restore evidence inputs are invalid.');
  }
  return {
    schema: 'pawshop-production-backup-restore-v1',
    release_id: releaseId,
    release_content_sha256: releaseContentSha256,
    migration_receipt_sha256: sha256(migrationSource),
    migration_set_sha256: migrationSetSha256,
    backup_manifest_file: backupManifestFile,
    encrypted_backup_sha256: encryptedBackupSha256,
    restore_verification_file: restoreVerificationFile,
    restore_verification_sha256: sha256(restoreVerificationSource),
    restore_verified_at: restoreVerifiedAt,
    isolated_cluster_removed: true,
    status: 'succeeded',
  };
}

module.exports = { assertRestoreVerification, backupRestoreEvidence, sha256 };
