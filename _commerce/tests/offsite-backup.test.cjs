'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  MIN_LOCAL_AGE_MS, offsiteReceiptIsValid, remoteObjectKey, selectLocalPruneCandidates, validateOffsiteConfig,
} = require('../scripts/offsite-backup-policy.cjs');
const { backupReceiptHmac } = require('../scripts/backup-integrity.cjs');
const { assertVersioningEnabled, uploadAndReadBack } = require('../scripts/offsite-s3-client.cjs');

const env = {
  PAWSHOP_BACKUP_S3_ENDPOINT: 'https://s3.example.invalid',
  PAWSHOP_BACKUP_S3_REGION: 'us-east-1',
  PAWSHOP_BACKUP_S3_BUCKET: 'pawshop-backups',
  PAWSHOP_BACKUP_S3_FORCE_PATH_STYLE: '0',
  PAWSHOP_BACKUP_S3_VERSIONING_CONFIRMED: '1',
  PAWSHOP_BACKUP_S3_DELETE_DISABLED: '1',
  PAWSHOP_BACKUP_S3_RETENTION_DAYS: '180',
};
const credentials = { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret-value' };

test('offsite config requires HTTPS, versioning, no-delete credentials, and 90 day retention', () => {
  assert.equal(validateOffsiteConfig(env, credentials).retentionDays, 180);
  for (const mutation of [
    { PAWSHOP_BACKUP_S3_ENDPOINT: 'http://s3.example.invalid' },
    { PAWSHOP_BACKUP_S3_VERSIONING_CONFIRMED: '0' },
    { PAWSHOP_BACKUP_S3_DELETE_DISABLED: '0' },
    { PAWSHOP_BACKUP_S3_RETENTION_DAYS: '30' },
  ]) assert.throws(() => validateOffsiteConfig({ ...env, ...mutation }, credentials));
  assert.throws(() => remoteObjectKey('../escape.dump.enc'));
});

test('local pruning keeps seven newest, latest, young, and unverified backup sets', () => {
  const now = Date.now();
  const entries = Array.from({ length: 12 }, (_, index) => ({
    createdAtMs: now - index * 24 * 60 * 60 * 1000,
    manifestFile: `m${index}`,
    remoteVerified: true,
  }));
  entries[10].remoteVerified = false;
  const candidates = selectLocalPruneCandidates(entries, 'm11', now + MIN_LOCAL_AGE_MS);
  assert.deepEqual(candidates.map(entry => entry.manifestFile), ['m7', 'm8', 'm9']);
});

test('offsite receipt authentication binds the current manifest bytes', () => {
  const backupKey = Buffer.alloc(32, 9);
  const manifestFile = 'pawshop_production_20260908T000000000Z.manifest.json';
  const manifest = {
    encrypted_file: 'pawshop_production_20260908T000000000Z.dump.enc', sha256: 'a'.repeat(64),
  };
  const core = {
    schema: 'pawshop-offsite-backup-receipt-v1', verified_at: '2026-09-08T00:00:01.000Z',
    manifest_file: manifestFile, encrypted_file: manifest.encrypted_file,
    encrypted_sha256: manifest.sha256, manifest_sha256: 'b'.repeat(64), bucket: 'pawshop-backups',
    encrypted_object_key: remoteObjectKey(manifest.encrypted_file), encrypted_version_id: 'enc-v1',
    manifest_object_key: remoteObjectKey(manifestFile), manifest_version_id: 'manifest-v1',
  };
  const receipt = { ...core, receipt_hmac_sha256: backupReceiptHmac(core, backupKey) };
  const input = { manifest, manifestFile, manifestHash: core.manifest_sha256, bucket: core.bucket, backupKey };
  assert.equal(offsiteReceiptIsValid(receipt, input), true);
  assert.equal(offsiteReceiptIsValid(receipt, { ...input, manifestHash: 'c'.repeat(64) }), false);
});

test('S3 upload requires versioning and verifies newly uploaded bytes by full read-back', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pawshop-offsite-'));
  const file = join(directory, 'artifact');
  const body = Buffer.from('encrypted fixture');
  writeFileSync(file, body);
  const sha256 = require('node:crypto').createHash('sha256').update(body).digest('hex');
  const commands = [];
  const client = { send: async command => {
    commands.push(command.constructor.name);
    if (command.constructor.name === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
    if (command.constructor.name === 'HeadObjectCommand') throw { $metadata: { httpStatusCode: 404 } };
    if (command.constructor.name === 'PutObjectCommand') {
      for await (const _chunk of command.input.Body) {
        // Consume the upload stream before the temporary fixture is removed.
      }
      return { ETag: 'etag', VersionId: 'v1' };
    }
    if (command.constructor.name === 'GetObjectCommand') {
      assert.equal(command.input.VersionId, 'v1');
      return { VersionId: 'v1', Body: (async function* () { yield body; })() };
    }
    throw new Error('unexpected command');
  } };
  try {
    await assertVersioningEnabled(client, 'pawshop-backups');
    const result = await uploadAndReadBack(client, {
      bucket: 'pawshop-backups', key: 'pawshop/database-backups/artifact', file,
      sha256, sizeBytes: body.length,
    });
    assert.equal(result.readBack, true);
    assert.deepEqual(commands, ['GetBucketVersioningCommand', 'HeadObjectCommand', 'PutObjectCommand', 'GetObjectCommand']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a prior receipt verifies its exact version rather than the current object', async () => {
  const body = Buffer.from('encrypted fixture');
  const sha256 = require('node:crypto').createHash('sha256').update(body).digest('hex');
  const commands = [];
  const client = { send: async command => {
    commands.push(command.constructor.name);
    if (command.constructor.name === 'HeadObjectCommand') {
      assert.equal(command.input.VersionId, 'recorded-version');
      return { ContentLength: body.length, Metadata: { sha256 }, VersionId: 'recorded-version' };
    }
    throw new Error('unexpected command');
  } };
  const result = await uploadAndReadBack(client, {
    bucket: 'pawshop-backups', key: 'pawshop/database-backups/artifact', file: '/not-opened',
    sha256, sizeBytes: body.length, expectedVersionId: 'recorded-version',
  });
  assert.equal(result.readBack, false);
  assert.equal(result.versionId, 'recorded-version');
  assert.deepEqual(commands, ['HeadObjectCommand']);
});

test('a mismatched GET version destroys its response body and fails closed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pawshop-offsite-mismatch-'));
  const file = join(directory, 'artifact');
  const bytes = Buffer.from('encrypted fixture');
  writeFileSync(file, bytes);
  const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  let destroyed = false;
  const responseBody = {
    async *[Symbol.asyncIterator]() { yield bytes; },
    destroy() { destroyed = true; },
  };
  const client = { send: async command => {
    if (command.constructor.name === 'HeadObjectCommand') throw { $metadata: { httpStatusCode: 404 } };
    if (command.constructor.name === 'PutObjectCommand') {
      for await (const _chunk of command.input.Body) {}
      return { VersionId: 'uploaded-version' };
    }
    if (command.constructor.name === 'GetObjectCommand') {
      assert.equal(command.input.VersionId, 'uploaded-version');
      return { VersionId: 'different-version', Body: responseBody };
    }
    throw new Error('unexpected command');
  } };
  try {
    await assert.rejects(() => uploadAndReadBack(client, {
      bucket: 'pawshop-backups', key: 'pawshop/database-backups/artifact', file,
      sha256, sizeBytes: bytes.length,
    }), /exact-version read-back request failed/);
    assert.equal(destroyed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
