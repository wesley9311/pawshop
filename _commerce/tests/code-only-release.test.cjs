'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  assertCodeOnlyDiff, assertCodeOnlyEvidence, codeOnlyEvidence, sensitiveReleasePath,
} = require('../scripts/code-only-release.cjs');

const root = resolve(__dirname, '..', '..');
const deploy = readFileSync(resolve(root, 'ops/commerce/deploy-commerce.sh'), 'utf8');
const prepare = readFileSync(resolve(root, 'ops/commerce/prepare-code-only-release.sh'), 'utf8');
const writer = readFileSync(resolve(root, '_commerce/scripts/write-code-only-release-evidence.mjs'), 'utf8');
const verifier = readFileSync(resolve(root, '_commerce/scripts/verify-release-evidence.mjs'), 'utf8');
const rollback = readFileSync(resolve(root, 'ops/commerce/rollback-commerce.sh'), 'utf8');

const candidate = '2'.repeat(40);
const predecessor = '1'.repeat(40);
const candidateDigest = 'a'.repeat(64);
const predecessorDigest = 'b'.repeat(64);
const migrationDigest = 'c'.repeat(64);
const diffDigest = 'd'.repeat(64);
const changedPaths = [
  '_commerce/medusa-config.ts',
  '_commerce/package-lock.json',
  '_commerce/scripts/admin-native-image-compression-plugin.cjs',
  '_commerce/src/admin/lib/native-image-compression.ts',
  '_commerce/tests/native-image-compression.test.cjs',
];

function evidence() {
  return codeOnlyEvidence({
    releaseId: candidate,
    releaseContentSha256: candidateDigest,
    predecessorReleaseId: predecessor,
    predecessorContentSha256: predecessorDigest,
    migrationSetSha256: migrationDigest,
    diffSha256: diffDigest,
    changedPaths,
    capturedAt: '2026-09-24T00:00:00.000Z',
  });
}

test('the native Admin image fix is an allowed code-only diff', () => {
  assert.doesNotThrow(() => assertCodeOnlyDiff(changedPaths));
  for (const path of changedPaths) assert.equal(sensitiveReleasePath(path), false);
});

test('schema and migration paths fail closed', () => {
  for (const path of [
    '_commerce/src/modules/orders/models/order.ts',
    '_commerce/src/links/product-media.ts',
    '_commerce/src/migrations/Migration20260924.ts',
    '_commerce/.medusa/server/src/migrations/generated.js',
    'ops/commerce/run-production-upgrade-migration.sh',
  ]) {
    assert.equal(sensitiveReleasePath(path), true, path);
    assert.throws(() => assertCodeOnlyDiff([path]), /schema or migration path/);
  }
  assert.match(writer, /candidateMigrations\.sha256 !== predecessorMigrations\.sha256/);
  assert.match(writer, /prepared migration set changed/);
});

test('code-only evidence is bound to candidate digest, predecessor snapshot, and exact diff', () => {
  const value = evidence();
  assert.doesNotThrow(() => assertCodeOnlyEvidence(value, {
    releaseId: candidate,
    releaseContentSha256: candidateDigest,
    predecessorReleaseId: predecessor,
    predecessorContentSha256: predecessorDigest,
    migrationSetSha256: migrationDigest,
    diffSha256: diffDigest,
    changedPaths,
  }));
  for (const mutation of [
    { release_content_sha256: 'e'.repeat(64) },
    { predecessor_content_sha256: 'e'.repeat(64) },
    { diff_sha256: 'e'.repeat(64) },
    { changed_paths_sha256: 'e'.repeat(64) },
  ]) {
    assert.throws(() => assertCodeOnlyEvidence({ ...value, ...mutation }, {
      releaseId: candidate,
      releaseContentSha256: candidateDigest,
      predecessorReleaseId: predecessor,
      predecessorContentSha256: predecessorDigest,
      migrationSetSha256: migrationDigest,
      diffSha256: diffDigest,
      changedPaths,
    }));
  }
  assert.match(verifier, /code-only\.json/);
  assert.match(verifier, /cannot be mixed with migration or restore evidence/);
});

test('code-only activation remains explicit, health-checked, atomic, and rollback-capable', () => {
  assert.match(prepare, /CODE_ONLY_RELEASE=1/);
  assert.match(prepare, /write-code-only-release-evidence\.mjs/);
  assert.doesNotMatch(prepare, /db:migrate|restore-verify|backup\.service/);
  assert.match(deploy, /CODE_ONLY_RELEASE_CONFIRMED/);
  assert.match(deploy, /mv -Tf -- .*current_link/);
  assert.match(deploy, /trap rollback ERR INT TERM/);
  assert.match(deploy, /127\.0\.0\.1:9000\/health/);
  assert.match(deploy, /atomic_link "\$previous_target"/);
  assert.doesNotMatch(deploy, /systemctl start pawshop-backup|run-first-production-migration/);
  assert.match(rollback, /PAWSHOP_ROLLBACK_COMPATIBLE/);
  assert.match(rollback, /mv -Tf -- .*current_link/);
  assert.match(rollback, /trap restore_previous ERR INT TERM/);
});
