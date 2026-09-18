import {
  chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assertProductionBackupManifest, backupReceiptHmac, digestFile, equalHex, manifestKeyTest, matchBackupKeyRing,
} = require('./backup-integrity.cjs');
const {
  offsiteReceiptIsValid, remoteObjectKey, selectLocalPruneCandidates, validateOffsiteConfig,
} = require('./offsite-backup-policy.cjs');
const { createBackupS3Client, headRemoteObject, uploadAndReadBack } = require('./offsite-s3-client.cjs');
const {
  assertBackupArtifactStat, assertBackupDirectoryStat, productionPrivatePaths, readProductionBackupKeyRing,
} = require('./production-private-paths.cjs');

if (process.platform !== 'linux' || process.getuid() === 0) {
  throw new Error('Production offsite backup sync requires the unprivileged Ubuntu service account.');
}
const { backupDir } = productionPrivatePaths(process.env);
assertBackupDirectoryStat(lstatSync(backupDir), process.getuid());
// Every manifest in the directory is verified against the whole key ring rather
// than the live key alone. After a rotation the older sets were encrypted with a
// key that is now retired, and the daily sync has to keep authenticating,
// uploading and pruning them, so the per-manifest match below decides which key
// applies instead of assuming the newest one does.
const keyRing = readProductionBackupKeyRing({ serviceGid: process.getgid() });

const credentialsDir = resolve(process.env.CREDENTIALS_DIRECTORY || '');
if (credentialsDir !== '/run/credentials/pawshop-backup.service' &&
    !/^\/run\/credentials\/pawshop-first-backup-[0-9a-f]{12}\.service$/.test(credentialsDir)) {
  throw new Error('Backup object storage credentials must come from the systemd credential directory.');
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
const lockFile = join(backupDir, '.offsite-sync.lock');
let lockFd;
try { lockFd = openSync(lockFile, 'wx', 0o600); }
catch { throw new Error('Another offsite backup sync may be active or needs operator recovery.'); }
const operationController = new AbortController();
let operationTimer;
let client;

async function sync(abortSignal) {
  // Bucket versioning is proved per uploaded object by the client, never by
  // reading bucket metadata: the backup identity is denied every bucket-level
  // action on purpose. See the contract at the top of offsite-s3-client.cjs.
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

const latest = privateJson(join(backupDir, 'latest.json'), 'Latest backup pointer');
if (!/^pawshop_production_[0-9]{8}T[0-9]{9}Z\.manifest\.json$/.test(latest.manifest_file || '')) {
  throw new Error('Latest backup pointer is unsafe.');
}
const manifestNames = readdirSync(backupDir).filter(name =>
  /^pawshop_production_[0-9]{8}T[0-9]{9}Z\.manifest\.json$/.test(name)
).sort();
if (manifestNames.length === 0 || !manifestNames.includes(latest.manifest_file)) {
  throw new Error('No valid production backup manifests include the latest pointer.');
}

const entries = [];
for (const manifestName of manifestNames) {
  const manifestFile = join(backupDir, manifestName);
  const manifest = privateJson(manifestFile, 'Production backup manifest');
  const { expectedEncrypted } = assertProductionBackupManifest(manifest, manifestName);
  // The key that authenticates this manifest is the key that encrypts its
  // archive, signs its offsite receipt, and must sign any receipt written now.
  // Taking it from the ring instead of the live key file is what lets the daily
  // sync keep serving sets that were encrypted before a rotation.
  const keyEntry = matchBackupKeyRing(keyRing, manifestKeyTest(manifest));
  if (!keyEntry) throw new Error('Production backup manifest authentication failed.');
  const encryptedFile = join(backupDir, expectedEncrypted);
  const encryptedStat = lstatSync(encryptedFile);
  assertBackupArtifactStat(encryptedStat, process.getuid());
  if (encryptedStat.size !== manifest.size_bytes) throw new Error('Production backup archive size mismatch.');
  const encryptedHash = await digestFile(encryptedFile);
  if (!equalHex(encryptedHash, manifest.sha256)) throw new Error('Production backup archive checksum mismatch.');
  const manifestHash = await digestFile(manifestFile);
  const receiptFile = join(backupDir, manifestName.replace(/\.manifest\.json$/, '.offsite.json'));
  const priorReceipt = existsSync(receiptFile) ? privateJson(receiptFile, 'Offsite backup receipt') : null;
  const priorVerified = offsiteReceiptIsValid(priorReceipt, {
    manifest, manifestFile, manifestHash, bucket: config.bucket, backupKey: keyEntry.key,
  });
  const encryptedRemote = await uploadAndReadBack(client, {
    bucket: config.bucket, key: remoteObjectKey(expectedEncrypted), file: encryptedFile,
    sha256: encryptedHash, sizeBytes: encryptedStat.size,
    expectedVersionId: priorVerified ? priorReceipt.encrypted_version_id : '', abortSignal,
  });
  const manifestRemote = await uploadAndReadBack(client, {
    bucket: config.bucket, key: remoteObjectKey(manifestName), file: manifestFile,
    sha256: manifestHash, sizeBytes: statSync(manifestFile).size,
    expectedVersionId: priorVerified ? priorReceipt.manifest_version_id : '', abortSignal,
  });
  if (!encryptedRemote.versionId || !manifestRemote.versionId) {
    throw new Error('Backup object storage did not return version identifiers.');
  }
  const receiptCore = {
    schema: 'pawshop-offsite-backup-receipt-v1', verified_at: new Date().toISOString(),
    manifest_file: manifestName, encrypted_file: expectedEncrypted,
    encrypted_sha256: encryptedHash, manifest_sha256: manifestHash, bucket: config.bucket,
    encrypted_object_key: remoteObjectKey(expectedEncrypted), encrypted_version_id: encryptedRemote.versionId,
    manifest_object_key: remoteObjectKey(manifestName), manifest_version_id: manifestRemote.versionId,
  };
  const receipt = { ...receiptCore, receipt_hmac_sha256: backupReceiptHmac(receiptCore, keyEntry.key) };
  atomicPrivateWrite(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  entries.push({
    createdAtMs: Date.parse(manifest.created_at), manifestFile: manifestName, encryptedFile: expectedEncrypted,
    receiptFile: basename(receiptFile), manifestHash, remoteVerified: true,
  });
}

let pruned = 0;
for (const entry of selectLocalPruneCandidates(entries, latest.manifest_file, Date.now())) {
  const receipt = privateJson(join(backupDir, entry.receiptFile), 'Offsite backup receipt');
  const manifest = privateJson(join(backupDir, entry.manifestFile), 'Production backup manifest');
  const keyEntry = matchBackupKeyRing(keyRing, manifestKeyTest(manifest));
  if (!keyEntry) throw new Error('Production backup manifest authentication failed.');
  if (!offsiteReceiptIsValid(receipt, {
    manifest, manifestFile: entry.manifestFile, manifestHash: entry.manifestHash,
    bucket: config.bucket, backupKey: keyEntry.key,
  })) {
    throw new Error('Local deletion refused because the offsite receipt is invalid.');
  }
  for (const [filename, sha256, sizeBytes, versionId] of [
    [entry.encryptedFile, receipt.encrypted_sha256, manifest.size_bytes, receipt.encrypted_version_id],
    [entry.manifestFile, receipt.manifest_sha256, lstatSync(join(backupDir, entry.manifestFile)).size, receipt.manifest_version_id],
  ]) {
    const remote = await headRemoteObject(client, {
      bucket: config.bucket, key: remoteObjectKey(filename), sha256, sizeBytes, versionId, abortSignal,
    });
    if (!remote?.versionId || remote.versionId !== versionId) {
      throw new Error('Local deletion refused because the recorded versioned offsite object is unavailable.');
    }
  }
  for (const filename of [entry.receiptFile, entry.manifestFile, entry.encryptedFile]) {
    const file = join(backupDir, filename);
    assertBackupArtifactStat(lstatSync(file), process.getuid());
    rmSync(file);
  }
  pruned += 1;
}

console.log(`Offsite encrypted backup sync completed; ${pruned} expired local backup set(s) pruned.`);
}

try {
  client = createBackupS3Client(config);
  operationTimer = setTimeout(() => operationController.abort(), 24 * 60_000);
  await sync(operationController.signal);
} finally {
  if (operationTimer) clearTimeout(operationTimer);
  client?.destroy();
  if (lockFd !== undefined) closeSync(lockFd);
  rmSync(lockFile, { force: true });
}
