'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { GetBucketVersioningCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

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

async function assertVersioningEnabled(client, bucket, abortSignal) {
  let result;
  try { result = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }), { abortSignal }); }
  catch { throw new Error('Backup bucket versioning could not be verified.'); }
  if (result.Status !== 'Enabled') throw new Error('Backup bucket versioning is not enabled.');
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

async function headRemoteObject(client, { bucket, key, sha256, sizeBytes, versionId = '', abortSignal }) {
  let head;
  try {
    head = await client.send(new HeadObjectCommand({
      Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}),
    }), { abortSignal });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new Error('Backup object head verification failed.');
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
      } catch {
        throw new Error('Existing backup object exact-version read-back request failed.');
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
  } catch {
    throw new Error('Backup object upload request failed.');
  } finally {
    uploadBody.destroy();
  }
  if (!validVersionId(upload.VersionId)) {
    throw new Error('Backup object storage did not return a version identifier after upload.');
  }
  let remoteDigest;
  try {
    remoteDigest = await readRemoteDigest(client, {
      bucket, key, versionId: upload.VersionId, abortSignal,
    });
  } catch {
    throw new Error('Backup object exact-version read-back request failed.');
  }
  if (remoteDigest !== sha256) {
    throw new Error('Uploaded backup object failed full read-back verification.');
  }
  return { etag: upload.ETag || '', versionId: upload.VersionId, uploaded: true, readBack: true };
}

module.exports = {
  assertVersioningEnabled,
  createBackupS3Client,
  digestRemoteBody,
  headRemoteObject,
  uploadAndReadBack,
};
