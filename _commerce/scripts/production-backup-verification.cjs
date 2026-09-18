'use strict';

// Verifying a production backup set means four things and they belong together:
// the manifest is authenticated with the backup key, the encrypted dump matches
// both its plain digest and its keyed HMAC, its size matches the manifest, and
// the offsite receipt is authenticated and agrees with the manifest byte for
// byte. Two pieces of evidence depend on that verification - the release that is
// about to be activated, and the restore point that an upgrade must hold before
// it touches the schema - so the contract lives here once instead of in each
// writer. A receipt field could otherwise be added in one place and forgotten in
// the other, which is exactly how the offsite sync once fell silently behind.

const { execFileSync } = require('node:child_process');
const { lstatSync, readFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const {
  assertProductionBackupManifest, digestFile, equalHex, manifestKeyTest, matchBackupKeyRing,
} = require('./backup-integrity.cjs');
const {
  OFFSITE_ENVIRONMENT_FIELDS, offsiteReceiptIsValid, validateOffsiteConfig,
} = require('./offsite-backup-policy.cjs');
const {
  readProductionBackupKeyRing, validateProductionBackupEnvironment,
} = require('./production-private-paths.cjs');

const PRODUCTION_BACKUP_DIR = '/var/backups/pawshop';
const PRODUCTION_BACKUP_ENVIRONMENT_FILE = '/etc/pawshop-backup/backup.env';
const PRODUCTION_OFFSITE_ENVIRONMENT_FILE = '/etc/pawshop-backup/backup-offsite.env';
// The name carries the authenticated creation timestamp, so the manifest cannot
// be renamed and the encrypted file name is derivable rather than declared.
const PRODUCTION_MANIFEST_FILE = /^pawshop_production_[0-9]{8}T[0-9]{9}Z\.manifest\.json$/;
const PRODUCTION_BACKUP_ENVIRONMENT_FIELDS = [
  'DATABASE_URL', 'NODE_ENV', 'PAWSHOP_BACKUP_DIR', 'PAWSHOP_BACKUP_KEY_FILE',
  'PAWSHOP_INFRA_TOPOLOGY', 'PAWSHOP_MODE',
].sort();

function backupServiceIds() {
  const read = flag => Number(execFileSync('/usr/bin/id', [flag, 'pawshop-backup'], { encoding: 'utf8' }).trim());
  const uid = read('-u');
  const gid = read('-g');
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) {
    throw new Error('The production backup service account is unavailable.');
  }
  return { uid, gid };
}

function assertPrivateFile(path, { uid, gid, mode, label, maximum = Number.MAX_SAFE_INTEGER }) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid ||
      (stat.mode & 0o777) !== mode || stat.size <= 0 || stat.size > maximum) {
    throw new Error(`${label} has unsafe ownership, type, permissions, or size.`);
  }
  return stat;
}

function parseEnvironmentContract(source, expectedFields, label) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\s'"\\]+)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) throw new Error(`${label} is invalid.`);
    values[match[1]] = match[2];
  }
  if (Object.keys(values).sort().join('\0') !== expectedFields.join('\0')) {
    throw new Error(`${label} fields do not match the approved contract.`);
  }
  return values;
}

function parseProductionBackupEnvironment(source) {
  const values = parseEnvironmentContract(source, PRODUCTION_BACKUP_ENVIRONMENT_FIELDS,
    'Production backup environment');
  validateProductionBackupEnvironment(values);
  return values;
}

function parseOffsiteEnvironment(source) {
  return parseEnvironmentContract(source, OFFSITE_ENVIRONMENT_FIELDS, 'Backup offsite environment');
}

async function verifyProductionBackupSet({ manifestName, expectedDatabase }) {
  if (!PRODUCTION_MANIFEST_FILE.test(manifestName || '')) {
    throw new Error('Production backup manifest name is invalid.');
  }
  const { uid: backupUid, gid: backupGid } = backupServiceIds();
  const manifestPath = join(PRODUCTION_BACKUP_DIR, manifestName);
  assertPrivateFile(manifestPath, {
    uid: backupUid, gid: backupGid, mode: 0o600,
    label: 'Production backup manifest', maximum: 64 * 1024,
  });
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch { throw new Error('Production backup manifest is invalid JSON.'); }
  const { expectedEncrypted } = assertProductionBackupManifest(manifest, manifestName);
  if (expectedDatabase !== undefined && manifest.source_database !== expectedDatabase) {
    throw new Error('Production backup was taken from a different database than the migrated one.');
  }
  const encryptedPath = join(PRODUCTION_BACKUP_DIR, expectedEncrypted);
  const encryptedStat = assertPrivateFile(encryptedPath, {
    uid: backupUid, gid: backupGid, mode: 0o600, label: 'Encrypted production backup',
  });
  if (manifest.size_bytes !== encryptedStat.size) {
    throw new Error('Encrypted production backup size does not match its manifest.');
  }
  // This runs long after the release was built and the set it judges may predate
  // a rotation, so the key comes from the ring: whichever key authenticates the
  // manifest is also the key that encrypts the archive and signs the offsite
  // receipt, and all three have to agree before any evidence is written.
  const keyRing = readProductionBackupKeyRing({ serviceGid: backupGid });
  const keyEntry = matchBackupKeyRing(keyRing, manifestKeyTest(manifest));
  if (!keyEntry) throw new Error('Production backup manifest authentication failed.');
  const [encryptedSha256, encryptedHmac] = await Promise.all([
    digestFile(encryptedPath),
    digestFile(encryptedPath, { hmacKey: keyEntry.key }),
  ]);
  if (!equalHex(encryptedSha256, manifest.sha256) || !equalHex(encryptedHmac, manifest.hmac_sha256)) {
    throw new Error('Encrypted production backup does not match its manifest.');
  }
  assertPrivateFile(PRODUCTION_OFFSITE_ENVIRONMENT_FILE, {
    uid: 0, gid: backupGid, mode: 0o640, label: 'Backup offsite environment', maximum: 16 * 1024,
  });
  const offsite = validateOffsiteConfig(parseOffsiteEnvironment(readFileSync(PRODUCTION_OFFSITE_ENVIRONMENT_FILE, 'utf8')), {
    accessKeyId: 'evidence-validation-key', secretAccessKey: 'evidence-validation-secret-value',
  });
  const receiptName = manifestName.replace(/\.manifest\.json$/, '.offsite.json');
  const receiptPath = join(PRODUCTION_BACKUP_DIR, receiptName);
  assertPrivateFile(receiptPath, {
    uid: backupUid, gid: backupGid, mode: 0o600, label: 'Offsite backup receipt', maximum: 64 * 1024,
  });
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); }
  catch { throw new Error('Offsite backup receipt is invalid JSON.'); }
  const manifestSha256 = await digestFile(manifestPath);
  if (!offsiteReceiptIsValid(receipt, {
    manifest, manifestFile: manifestPath, manifestHash: manifestSha256, bucket: offsite.bucket, backupKey: keyEntry.key,
  })) throw new Error('Versioned offsite backup receipt is invalid.');
  return {
    manifest, manifestPath, manifestSha256, encryptedFile: basename(encryptedPath), encryptedPath,
    encryptedSha256, receiptName, offsiteVerifiedAt: receipt.verified_at,
  };
}

module.exports = {
  PRODUCTION_BACKUP_DIR,
  PRODUCTION_BACKUP_ENVIRONMENT_FILE,
  PRODUCTION_MANIFEST_FILE,
  PRODUCTION_OFFSITE_ENVIRONMENT_FILE,
  assertPrivateFile,
  backupServiceIds,
  parseOffsiteEnvironment,
  parseProductionBackupEnvironment,
  verifyProductionBackupSet,
};
