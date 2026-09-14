'use strict';

const { createHash } = require('node:crypto');

const RELEASE_ID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function migrationSet(manifest) {
  if (!manifest || manifest.schema !== 'pawshop-prepared-release-v1' ||
      !RELEASE_ID.test(manifest.release_id || '') || !Array.isArray(manifest.files)) {
    throw new Error('Prepared release manifest is invalid for migration evidence.');
  }
  const entries = manifest.files.filter(entry =>
    entry?.type === 'file' && SHA256.test(entry.sha256 || '') &&
    /(^|\/)(?:migrations?|migration-scripts)(\/|$)/i.test(entry.path || '')
  ).map(entry => ({ path: entry.path, sha256: entry.sha256 }));
  if (entries.length === 0) throw new Error('Prepared release contains no migration files.');
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].path === entries[index].path) {
      throw new Error('Prepared release migration paths are not unique.');
    }
  }
  return {
    entries,
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
}

function migrationEvidence({ releaseId, releaseContentSha256, migrationSetSha256, completedAt }) {
  if (!RELEASE_ID.test(releaseId || '') || !SHA256.test(releaseContentSha256 || '') ||
      !SHA256.test(migrationSetSha256 || '') ||
      typeof completedAt !== 'string' || Number.isNaN(Date.parse(completedAt)) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(completedAt)) {
    throw new Error('Migration evidence inputs are invalid.');
  }
  return {
    schema: 'pawshop-production-migration-v1',
    release_id: releaseId,
    release_content_sha256: releaseContentSha256,
    database: 'pawshop',
    initialization: 'empty-database',
    completed_at: completedAt,
    command: 'db:migrate',
    migration_set_sha256: migrationSetSha256,
    status: 'succeeded',
  };
}

module.exports = { migrationEvidence, migrationSet };
