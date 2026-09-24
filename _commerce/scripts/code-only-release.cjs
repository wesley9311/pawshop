'use strict';

const { createHash } = require('node:crypto');

const RELEASE_ID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CODE_ONLY_SCHEMA = 'pawshop-code-only-release-v1';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw new Error(`${label} fields do not match the approved code-only contract.`);
  }
}

function sensitiveReleasePath(path) {
  if (typeof path !== 'string' || path.length < 1 || path.length > 1024 ||
      path.startsWith('/') || path.includes('\0') || path.includes('\r') || path.includes('\n') ||
      path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Code-only diff contains an unsafe path.');
  }
  return /(^|\/)(?:migrations?|migration-scripts)(?:\/|$)/i.test(path) ||
    /^_commerce\/src\/(?:modules|links|models)(?:\/|$)/i.test(path) ||
    /^_commerce\/scripts\/(?:first-production-migration|run-first-production-migration|write-production-migration-evidence|production-upgrade-evidence|write-production-upgrade-evidence)\.(?:cjs|mjs)$/i.test(path) ||
    /^ops\/commerce\/(?:run-first-production-migration|run-production-upgrade-migration)\.sh$/i.test(path);
}

function assertCodeOnlyDiff(paths) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 2048) {
    throw new Error('Code-only release requires a bounded, non-empty diff.');
  }
  const sorted = [...paths].sort();
  if (new Set(sorted).size !== sorted.length || JSON.stringify(paths) !== JSON.stringify(sorted)) {
    throw new Error('Code-only changed paths must be unique and sorted.');
  }
  const sensitive = paths.find(sensitiveReleasePath);
  if (sensitive) throw new Error(`Code-only release refused a schema or migration path: ${sensitive}`);
}

function codeOnlyEvidence({
  releaseId, releaseContentSha256, predecessorReleaseId, predecessorContentSha256,
  migrationSetSha256, diffSha256, changedPaths, capturedAt,
}) {
  assertCodeOnlyDiff(changedPaths);
  if (!RELEASE_ID.test(releaseId || '') || !RELEASE_ID.test(predecessorReleaseId || '') ||
      releaseId === predecessorReleaseId || !SHA256.test(releaseContentSha256 || '') ||
      !SHA256.test(predecessorContentSha256 || '') || !SHA256.test(migrationSetSha256 || '') ||
      !SHA256.test(diffSha256 || '') || typeof capturedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capturedAt) ||
      Number.isNaN(Date.parse(capturedAt))) {
    throw new Error('Code-only evidence inputs are invalid.');
  }
  return {
    schema: CODE_ONLY_SCHEMA,
    mode: 'code-only',
    release_id: releaseId,
    release_content_sha256: releaseContentSha256,
    predecessor_release_id: predecessorReleaseId,
    predecessor_content_sha256: predecessorContentSha256,
    migration_set_sha256: migrationSetSha256,
    diff_sha256: diffSha256,
    changed_paths_sha256: sha256(JSON.stringify(changedPaths)),
    changed_paths: changedPaths,
    production_snapshot: {
      current_release_id: predecessorReleaseId,
      current_release_content_sha256: predecessorContentSha256,
      commerce_service: 'active',
      migration_gate: 'enabled',
    },
    captured_at: capturedAt,
    status: 'approved',
  };
}

function assertCodeOnlyEvidence(value, {
  releaseId, releaseContentSha256, predecessorReleaseId, predecessorContentSha256,
  migrationSetSha256, diffSha256, changedPaths,
}) {
  exactKeys(value, [
    'schema', 'mode', 'release_id', 'release_content_sha256',
    'predecessor_release_id', 'predecessor_content_sha256', 'migration_set_sha256',
    'diff_sha256', 'changed_paths_sha256', 'changed_paths', 'production_snapshot',
    'captured_at', 'status',
  ], 'Code-only evidence');
  exactKeys(value.production_snapshot, [
    'current_release_id', 'current_release_content_sha256', 'commerce_service', 'migration_gate',
  ], 'Production snapshot');
  assertCodeOnlyDiff(value.changed_paths);
  const valid = value.schema === CODE_ONLY_SCHEMA && value.mode === 'code-only' &&
    value.release_id === releaseId && value.release_content_sha256 === releaseContentSha256 &&
    value.predecessor_release_id === predecessorReleaseId &&
    value.predecessor_content_sha256 === predecessorContentSha256 &&
    value.migration_set_sha256 === migrationSetSha256 && value.diff_sha256 === diffSha256 &&
    JSON.stringify(value.changed_paths) === JSON.stringify(changedPaths) &&
    RELEASE_ID.test(value.release_id || '') && RELEASE_ID.test(value.predecessor_release_id || '') &&
    value.release_id !== value.predecessor_release_id &&
    SHA256.test(value.release_content_sha256 || '') && SHA256.test(value.predecessor_content_sha256 || '') &&
    SHA256.test(value.migration_set_sha256 || '') && SHA256.test(value.diff_sha256 || '') &&
    value.changed_paths_sha256 === sha256(JSON.stringify(value.changed_paths)) &&
    value.production_snapshot.current_release_id === predecessorReleaseId &&
    value.production_snapshot.current_release_content_sha256 === predecessorContentSha256 &&
    value.production_snapshot.commerce_service === 'active' &&
    value.production_snapshot.migration_gate === 'enabled' && value.status === 'approved' &&
    typeof value.captured_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.captured_at) &&
    !Number.isNaN(Date.parse(value.captured_at));
  if (!valid) throw new Error('Code-only evidence is not approved for this exact release transition.');
}

module.exports = {
  CODE_ONLY_SCHEMA, assertCodeOnlyDiff, assertCodeOnlyEvidence, codeOnlyEvidence, sensitiveReleasePath, sha256,
};
