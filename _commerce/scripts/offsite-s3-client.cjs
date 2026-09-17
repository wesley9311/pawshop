'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

// Bucket versioning is never read from the bucket.
//
// The backup identity is deliberately denied every bucket-level action,
// including bucket metadata: on this bucket `GET /?versioning` and
// `GET /?lifecycle` both answer 403 AccessDenied for the backup credential.
// That denial is the point - the account that writes backups must not be able
// to delete them, nor to change when they expire - so a preflight that read the
// versioning status could never pass, and would couple the backup chain to a
// permission this design withholds.
//
// Versioning is proved per object instead, with the permissions the credential
// does have:
//   * every upload must come back with a version identifier. Storage returns
//     none when versioning is off, so the run fails closed;
//   * every remote object is authenticated by its exact version identifier,
//     both when a run reuses a recorded version and when it reads back new bytes.
// The operator gate PAWSHOP_BACKUP_S3_VERSIONING_CONFIRMED=1 records the
// setup-time proof, and verify-offsite-credential.mjs re-proves it functionally.

function createBackupS3Client(config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5_000,
      socketTimeout: 30_000,
      requestTimeout: 15 * 60_000,
      throwOnRequestTimeout: true,
    }),
  });
}

function isNotFound(error) {
  return error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;
}

async function digestRemoteBody(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new Error('Backup object returned an unreadable body.');
  const hash = createHash('sha256');
  for await (const chunk of body) hash.update(chunk);
  return hash.digest('hex');
}

function validVersionId(versionId) {
  return typeof versionId === 'string' && versionId.length > 0 && versionId.length <= 1024 && versionId !== 'null';
}

// The per-object versioning proof. A versioned bucket answers an upload with a
// version identifier; an unversioned one answers without one, which is a hard
// stop rather than a degraded backup.
function assertVersionedUpload(upload) {
  if (!validVersionId(upload?.VersionId)) {
    throw new Error('Backup object storage did not return a version identifier after upload; bucket versioning is not enabled.');
  }
}

async function headRemoteObject(client, { bucket, key, sha256, sizeBytes, versionId = '', abortSignal }) {
  let head;
  try {
    head = await client.send(new HeadObjectCommand({
      Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}),
    }), { abortSignal });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new Error('Backup object head verification failed.', { cause: error });
  }
  if (head.ContentLength !== sizeBytes || head.Metadata?.sha256 !== sha256) {
    throw new Error('Existing backup object does not match the authenticated local artifact.');
  }
  if (!validVersionId(head.VersionId) || (versionId && head.VersionId !== versionId)) {
    throw new Error('Backup object storage did not return the requested exact version identifier.');
  }
  return { etag: head.ETag || '', versionId: head.VersionId };
}

async function readRemoteDigest(client, { bucket, key, versionId, abortSignal }) {
  let body;
  try {
    const downloaded = await client.send(new GetObjectCommand({
      Bucket: bucket, Key: key, VersionId: versionId,
    }), { abortSignal });
    body = downloaded.Body;
    if (downloaded.VersionId !== versionId) {
      throw new Error('Backup object storage returned a different version than requested.');
    }
    return await digestRemoteBody(body);
  } finally {
    body?.destroy?.();
  }
}

async function uploadAndReadBack(client, {
  bucket, key, file, sha256, sizeBytes, expectedVersionId = '', abortSignal,
}) {
  const existing = await headRemoteObject(client, {
    bucket, key, sha256, sizeBytes, versionId: expectedVersionId, abortSignal,
  });
  if (existing) {
    if (!expectedVersionId) {
      let existingDigest;
      try {
        existingDigest = await readRemoteDigest(client, { bucket, key, versionId: existing.versionId, abortSignal });
      } catch (error) {
        throw new Error('Existing backup object exact-version read-back request failed.', { cause: error });
      }
      if (existingDigest !== sha256) {
        throw new Error('Existing backup object failed full read-back verification.');
      }
    }
    return { ...existing, uploaded: false, readBack: !expectedVersionId };
  }
  if (expectedVersionId) throw new Error('The recorded versioned backup object is unavailable.');
  let upload;
  const uploadBody = createReadStream(file);
  try {
    upload = await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: uploadBody, ContentLength: sizeBytes,
      ContentType: 'application/octet-stream',
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'), Metadata: { sha256 },
    }), { abortSignal });
  } catch (error) {
    throw new Error('Backup object upload request failed.', { cause: error });
  } finally {
    uploadBody.destroy();
  }
  assertVersionedUpload(upload);
  let remoteDigest;
  try {
    remoteDigest = await readRemoteDigest(client, {
      bucket, key, versionId: upload.VersionId, abortSignal,
    });
  } catch (error) {
    throw new Error('Backup object exact-version read-back request failed.', { cause: error });
  }
  if (remoteDigest !== sha256) {
    throw new Error('Uploaded backup object failed full read-back verification.');
  }
  return { etag: upload.ETag || '', versionId: upload.VersionId, uploaded: true, readBack: true };
}

module.exports = {
  assertVersionedUpload,
  createBackupS3Client,
  digestRemoteBody,
  headRemoteObject,
  uploadAndReadBack,
};
