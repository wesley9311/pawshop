'use strict';

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { createReadStream, readFileSync } = require('node:fs');
const { resolve, sep } = require('node:path');

const criticalTables = [
  ['product', 'id'],
  ['product_variant', 'id'],
  ['product_variant_price_set', 'variant_id, price_set_id'],
  ['price', 'id'],
  ['image', 'id'],
  ['customer', 'id'],
  ['"order"', 'id'],
  ['"user"', 'id'],
];
const productionManifestFields = [
  'created_at', 'encrypted_file', 'encryption', 'hmac_sha256', 'manifest_hmac_sha256',
  'schema', 'sha256', 'size_bytes', 'source_database',
].sort();

function criticalDataSha256(query) {
  const hash = createHash('sha256');
  for (const [table, order] of criticalTables) {
    const rows = query(`SELECT row_to_json(t)::text FROM (SELECT * FROM ${table} ORDER BY ${order}) t;`);
    hash.update(table).update('\0').update(rows).update('\0');
  }
  return hash.digest('hex');
}

function readBackupKey(keyFile) {
  const encoded = readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(encoded)) throw new Error('PawShop backup key has an invalid format.');
  return Buffer.from(encoded, 'hex');
}

function digestFile(file, { hmacKey } = {}) {
  return new Promise((resolveDigest, reject) => {
    const digest = hmacKey ? createHmac('sha256', hmacKey) : createHash('sha256');
    const input = createReadStream(file);
    input.on('data', (chunk) => digest.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolveDigest(digest.digest('hex')));
  });
}

function equalHex(left, right) {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function backupManifestHmac(manifest, key) {
  const authenticated = {
    schema: manifest.schema,
    created_at: manifest.created_at,
    source_database: manifest.source_database,
    encrypted_file: manifest.encrypted_file,
    encryption: manifest.encryption,
    sha256: manifest.sha256,
    hmac_sha256: manifest.hmac_sha256,
    size_bytes: manifest.size_bytes,
  };
  return createHmac('sha256', key).update(JSON.stringify(authenticated)).digest('hex');
}

function backupReceiptHmac(receipt, key) {
  const authenticated = {
    schema: receipt.schema,
    verified_at: receipt.verified_at,
    manifest_file: receipt.manifest_file,
    encrypted_file: receipt.encrypted_file,
    encrypted_sha256: receipt.encrypted_sha256,
    manifest_sha256: receipt.manifest_sha256,
    bucket: receipt.bucket,
    encrypted_object_key: receipt.encrypted_object_key,
    encrypted_version_id: receipt.encrypted_version_id,
    manifest_object_key: receipt.manifest_object_key,
    manifest_version_id: receipt.manifest_version_id,
  };
  return createHmac('sha256', key).update(JSON.stringify(authenticated)).digest('hex');
}

function backupArchiveReceiptHmac(receipt, key) {
  const authenticated = {
    schema: receipt.schema,
    archived_at: receipt.archived_at,
    archive_tier: receipt.archive_tier,
    archive_period: receipt.archive_period,
    source_created_at: receipt.source_created_at,
    manifest_file: receipt.manifest_file,
    encrypted_file: receipt.encrypted_file,
    encrypted_sha256: receipt.encrypted_sha256,
    encrypted_size_bytes: receipt.encrypted_size_bytes,
    manifest_sha256: receipt.manifest_sha256,
    manifest_size_bytes: receipt.manifest_size_bytes,
    bucket: receipt.bucket,
    encrypted_object_key: receipt.encrypted_object_key,
    encrypted_version_id: receipt.encrypted_version_id,
    manifest_object_key: receipt.manifest_object_key,
    manifest_version_id: receipt.manifest_version_id,
  };
  return createHmac('sha256', key).update(JSON.stringify(authenticated)).digest('hex');
}

// Rotating the backup key is the one maintenance action that can silently make
// history unreadable, so the ring is what makes it safe. Manifests, offsite
// receipts and archive receipts are all keyed by the same backup key, and a
// manifest's manifest_hmac_sha256 binds the archive that key decrypts, so the
// question "which key signed this artifact?" is answered by re-authenticating it
// against each key in turn - never by assuming the newest key. Callers therefore
// pass the test that fits their artifact and take back the entry that passes,
// which keeps every old backup set readable after a rotation and means a retired
// key can only ever read. The fingerprint is a digest of the key material and is
// what the retired file names carry, so an operator can tell the keys apart
// without any of them being printed.
function backupKeyFingerprint(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

// Matching is a query rather than an assertion: it returns the ring entry whose
// key passes the caller's test, or null. Each caller already has a specific,
// actionable failure message for its own artifact - "manifest", "offsite
// receipt", "archive receipt" - and those differ in what an operator should do
// next, so the ring reports the match and the caller reports the verdict. Only
// misuse of the primitive itself throws.
function matchBackupKeyRing(keyRing, authenticates) {
  if (!Array.isArray(keyRing) || keyRing.length === 0) {
    throw new Error('The production backup key ring is empty.');
  }
  if (typeof authenticates !== 'function') {
    throw new Error('Matching a production backup key ring requires an authentication test.');
  }
  for (const entry of keyRing) {
    if (entry && entry.key && authenticates(entry.key)) return entry;
  }
  return null;
}

// The dominant test, expressed once: a manifest is authentic under the key that
// also encrypts the archive it describes.
function manifestKeyTest(manifest) {
  return (key) => equalHex(backupManifestHmac(manifest, key), manifest?.manifest_hmac_sha256);
}

function assertProductionBackupManifest(manifest, manifestFileName) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      Object.keys(manifest).sort().join('\0') !== productionManifestFields.join('\0') ||
      manifest.schema !== 'pawshop-production-backup-v1' ||
      manifest.encryption !== 'AES-256-CBC PBKDF2' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(manifest.source_database || '') ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.created_at || '') ||
      !Number.isSafeInteger(Date.parse(manifest.created_at)) ||
      !/^[0-9a-f]{64}$/i.test(manifest.sha256 || '') || !/^[0-9a-f]{64}$/i.test(manifest.hmac_sha256 || '') ||
      !/^[0-9a-f]{64}$/i.test(manifest.manifest_hmac_sha256 || '') ||
      !Number.isSafeInteger(manifest.size_bytes) || manifest.size_bytes <= 0) {
    throw new Error('Production backup manifest has unsupported or unsafe metadata.');
  }
  const stamp = manifest.created_at.replaceAll(/[-:.]/g, '');
  const expectedEncrypted = `pawshop_production_${stamp}.dump.enc`;
  const expectedManifest = `pawshop_production_${stamp}.manifest.json`;
  if (manifest.encrypted_file !== expectedEncrypted || (manifestFileName && manifestFileName !== expectedManifest)) {
    throw new Error('Production backup manifest filenames do not match its authenticated timestamp.');
  }
  return { expectedEncrypted, expectedManifest };
}

function constrainedBackupPath(backupDir, candidate, label) {
  const base = resolve(backupDir);
  const target = resolve(candidate);
  if (!target.startsWith(`${base}${sep}`)) throw new Error(`${label} must remain inside the private backup directory.`);
  return target;
}

module.exports = {
  assertProductionBackupManifest,
  backupArchiveReceiptHmac,
  backupKeyFingerprint,
  backupManifestHmac,
  backupReceiptHmac,
  constrainedBackupPath,
  criticalDataSha256,
  digestFile,
  equalHex,
  manifestKeyTest,
  matchBackupKeyRing,
  readBackupKey,
};
