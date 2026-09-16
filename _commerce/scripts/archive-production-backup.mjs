import {
  chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assertProductionBackupManifest, backupArchiveReceiptHmac, backupManifestHmac, digestFile, equalHex, readBackupKey,
} = require('./backup-integrity.cjs');
const {
  archivePeriod, archiveReceiptIsValid, remoteObjectKey, validateOffsiteConfig,
} = require('./offsite-backup-policy.cjs');
const {
  assertVersioningEnabled, createBackupS3Client, headRemoteObject, uploadAndReadBack,
} = require('./offsite-s3-client.cjs');
const {
  assertBackupArtifactStat, assertBackupDirectoryStat, assertBackupKeyStat, productionPrivatePaths,
} = require('./production-private-paths.cjs');

if (process.platform !== 'linux' || process.getuid() === 0) {
  throw new Error('Production backup archiving requires the unprivileged Ubuntu service account.');
}
const tier = process.env.PAWSHOP_BACKUP_ARCHIVE_TIER || '';
if (!['monthly', 'yearly'].includes(tier)) throw new Error('Production backup archive tier is invalid.');

const { backupDir, backupKeyFile } = productionPrivatePaths(process.env);
assertBackupDirectoryStat(lstatSync(backupDir), process.getuid());
assertBackupKeyStat(lstatSync(backupKeyFile), process.getgid());
const backupKey = readBackupKey(backupKeyFile);
const credentialsDir = resolve(process.env.CREDENTIALS_DIRECTORY || '');
if (credentialsDir !== `/run/credentials/pawshop-backup-${tier}.service`) {
  throw new Error('Backup archive credentials must come from the exact systemd credential directory.');
}
function credential(name) {
  const value = readFileSync(join(credentialsDir, name), 'utf8').trim();
  if (!value) throw new Error('A backup object storage credential is empty.');
  return value;
}
const config = validateOffsiteConfig(process.env, {
  accessKeyId: credential('backup-s3-access-key'),
  secretAccessKey: credential('backup-s3-secret-key'),
});
const period = archivePeriod(tier);
const receiptFile = join(backupDir, `.archive-${tier}-${period}.offsite.json`);
const lockFile = join(backupDir, '.offsite-sync.lock');
let lockFd;
try { lockFd = openSync(lockFile, 'wx', 0o600); }
catch { throw new Error('Another offsite backup operation may be active or needs operator recovery.'); }
const operationController = new AbortController();
let operationTimer;
let client;

function privateJson(file, label) {
  const stat = lstatSync(file);
  assertBackupArtifactStat(stat, process.getuid());
  if (stat.size <= 0 || stat.size > 64 * 1024) throw new Error(`${label} has an unsafe size.`);
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`${label} is invalid JSON.`); }
}

function atomicPrivateWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function verifyExistingReceipt(receipt, abortSignal) {
  if (!archiveReceiptIsValid(receipt, { tier, period, bucket: config.bucket, backupKey })) {
    throw new Error('Existing archive receipt failed authentication; operator review is required.');
  }
  for (const [key, hash, size, versionId] of [
    [receipt.encrypted_object_key, receipt.encrypted_sha256, receipt.encrypted_size_bytes, receipt.encrypted_version_id],
    [receipt.manifest_object_key, receipt.manifest_sha256, receipt.manifest_size_bytes, receipt.manifest_version_id],
  ]) {
    const remote = await headRemoteObject(client, {
      bucket: config.bucket, key, sha256: hash, sizeBytes: size, versionId, abortSignal,
    });
    if (!remote || remote.versionId !== versionId) throw new Error('Archived backup exact version is unavailable.');
  }
}

async function archive(abortSignal) {
  await assertVersioningEnabled(client, config.bucket, abortSignal);
  if (existsSync(receiptFile)) {
    await verifyExistingReceipt(privateJson(receiptFile, 'Archive receipt'), abortSignal);
    console.log(`The ${tier} encrypted backup archive already exists and its exact versions were verified.`);
    return;
  }

  const latest = privateJson(join(backupDir, 'latest.json'), 'Latest backup pointer');
  if (!/^pawshop_production_[0-9]{8}T[0-9]{9}Z\.manifest\.json$/.test(latest.manifest_file || '')) {
    throw new Error('Latest backup pointer is unsafe.');
  }
  const manifestFile = join(backupDir, latest.manifest_file);
  const manifest = privateJson(manifestFile, 'Production backup manifest');
  const { expectedEncrypted } = assertProductionBackupManifest(manifest, latest.manifest_file);
  if (archivePeriod(tier, new Date(manifest.created_at)) !== period) {
    throw new Error(`The latest encrypted backup does not belong to the current ${tier} archive period.`);
  }
  if (!equalHex(backupManifestHmac(manifest, backupKey), manifest.manifest_hmac_sha256)) {
    throw new Error('Production backup manifest authentication failed.');
  }
  const encryptedFile = join(backupDir, expectedEncrypted);
  const encryptedStat = lstatSync(encryptedFile);
  assertBackupArtifactStat(encryptedStat, process.getuid());
  if (encryptedStat.size !== manifest.size_bytes) throw new Error('Production backup archive size mismatch.');
  const encryptedHash = await digestFile(encryptedFile);
  if (!equalHex(encryptedHash, manifest.sha256)) throw new Error('Production backup archive checksum mismatch.');
  const manifestHash = await digestFile(manifestFile);
  const manifestSize = statSync(manifestFile).size;
  const encryptedKey = remoteObjectKey(expectedEncrypted, tier, period);
  const manifestKey = remoteObjectKey(latest.manifest_file, tier, period);
  const encryptedRemote = await uploadAndReadBack(client, {
    bucket: config.bucket, key: encryptedKey, file: encryptedFile,
    sha256: encryptedHash, sizeBytes: encryptedStat.size, abortSignal,
  });
  const manifestRemote = await uploadAndReadBack(client, {
    bucket: config.bucket, key: manifestKey, file: manifestFile,
    sha256: manifestHash, sizeBytes: manifestSize, abortSignal,
  });
  const receiptCore = {
    schema: 'pawshop-offsite-archive-receipt-v1', archived_at: new Date().toISOString(),
    archive_tier: tier, archive_period: period, source_created_at: manifest.created_at,
    manifest_file: latest.manifest_file, encrypted_file: expectedEncrypted,
    encrypted_sha256: encryptedHash, encrypted_size_bytes: encryptedStat.size,
    manifest_sha256: manifestHash, manifest_size_bytes: manifestSize, bucket: config.bucket,
    encrypted_object_key: encryptedKey, encrypted_version_id: encryptedRemote.versionId,
    manifest_object_key: manifestKey, manifest_version_id: manifestRemote.versionId,
  };
  const receipt = {
    ...receiptCore, archive_receipt_hmac_sha256: backupArchiveReceiptHmac(receiptCore, backupKey),
  };
  atomicPrivateWrite(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`The ${tier} encrypted backup archive was uploaded and exact-version verified.`);
}

try {
  client = createBackupS3Client(config);
  operationTimer = setTimeout(() => operationController.abort(), 24 * 60_000);
  await archive(operationController.signal);
} finally {
  if (operationTimer) clearTimeout(operationTimer);
  client?.destroy();
  if (lockFd !== undefined) closeSync(lockFd);
  rmSync(lockFile, { force: true });
}
