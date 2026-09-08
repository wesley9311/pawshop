'use strict';

const { basename } = require('node:path');
const { backupReceiptHmac, equalHex } = require('./backup-integrity.cjs');

const MIN_LOCAL_COPIES = 7;
const MIN_LOCAL_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const REMOTE_PREFIX = 'pawshop/database-backups';

function validateOffsiteConfig(env, credentials) {
  let endpoint;
  try { endpoint = new URL(env.PAWSHOP_BACKUP_S3_ENDPOINT || ''); } catch { throw new Error('Backup object storage endpoint is invalid.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('Backup object storage endpoint must be an explicit HTTPS origin.');
  }
  const region = env.PAWSHOP_BACKUP_S3_REGION || '';
  const bucket = env.PAWSHOP_BACKUP_S3_BUCKET || '';
  const forcePathStyle = env.PAWSHOP_BACKUP_S3_FORCE_PATH_STYLE || '0';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(region) ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      !['0', '1'].includes(forcePathStyle)) {
    throw new Error('Backup object storage region, bucket, or path-style setting is invalid.');
  }
  if (env.PAWSHOP_BACKUP_S3_VERSIONING_CONFIRMED !== '1' || env.PAWSHOP_BACKUP_S3_DELETE_DISABLED !== '1') {
    throw new Error('Backup bucket versioning and delete-disabled credential gates must be confirmed.');
  }
  const retentionDays = Number(env.PAWSHOP_BACKUP_S3_RETENTION_DAYS);
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 90) {
    throw new Error('Offsite backup retention must be at least 90 days.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(credentials.accessKeyId || '') ||
      typeof credentials.secretAccessKey !== 'string' || credentials.secretAccessKey.length < 16) {
    throw new Error('Backup object storage credentials are invalid.');
  }
  return {
    endpoint: endpoint.origin, region, bucket,
    forcePathStyle: forcePathStyle === '1', retentionDays,
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey },
  };
}

function remoteObjectKey(filename) {
  if (!/^pawshop_production_[0-9]{8}T[0-9]{9}Z\.(?:dump\.enc|manifest\.json)$/.test(filename)) {
    throw new Error('Backup object filename is unsafe.');
  }
  return `${REMOTE_PREFIX}/${filename}`;
}

function offsiteReceiptIsValid(receipt, { manifest, manifestFile, manifestHash, bucket, backupKey }) {
  const fields = [
    'bucket', 'encrypted_file', 'encrypted_object_key', 'encrypted_sha256', 'encrypted_version_id',
    'manifest_file', 'manifest_object_key', 'manifest_sha256', 'manifest_version_id',
    'receipt_hmac_sha256', 'schema', 'verified_at',
  ].sort();
  return receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
    Object.keys(receipt).sort().join('\0') === fields.join('\0') &&
    receipt.schema === 'pawshop-offsite-backup-receipt-v1' &&
    receipt.manifest_file === basename(manifestFile) &&
    receipt.encrypted_file === manifest.encrypted_file &&
    receipt.encrypted_sha256 === manifest.sha256 &&
    receipt.manifest_sha256 === manifestHash &&
    receipt.bucket === bucket &&
    receipt.encrypted_object_key === remoteObjectKey(manifest.encrypted_file) &&
    receipt.manifest_object_key === remoteObjectKey(basename(manifestFile)) &&
    typeof receipt.encrypted_version_id === 'string' && receipt.encrypted_version_id.length > 0 && receipt.encrypted_version_id.length <= 1024 &&
    typeof receipt.manifest_version_id === 'string' && receipt.manifest_version_id.length > 0 && receipt.manifest_version_id.length <= 1024 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.verified_at || '') &&
    Number.isSafeInteger(Date.parse(receipt.verified_at)) &&
    equalHex(backupReceiptHmac(receipt, backupKey), receipt.receipt_hmac_sha256);
}

function selectLocalPruneCandidates(entries, latestManifest, nowMs) {
  const ordered = [...entries].sort((a, b) => b.createdAtMs - a.createdAtMs);
  return ordered.slice(MIN_LOCAL_COPIES).filter(entry =>
    entry.manifestFile !== latestManifest && entry.remoteVerified === true &&
    Number.isSafeInteger(entry.createdAtMs) && nowMs - entry.createdAtMs >= MIN_LOCAL_AGE_MS
  );
}

module.exports = {
  MIN_LOCAL_AGE_MS,
  MIN_LOCAL_COPIES,
  REMOTE_PREFIX,
  offsiteReceiptIsValid,
  remoteObjectKey,
  selectLocalPruneCandidates,
  validateOffsiteConfig,
};
