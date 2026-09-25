'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const {
  patchFileUpload,
  patchProductMediaUpload,
  patchProductMediaSubmittingState,
  patchProductCreateUpload,
  patchProductCreateSubmittingState,
  SUPPORTED_DASHBOARD_VERSION,
} = require('../scripts/admin-native-image-compression-plugin.cjs');
const compressionPolicy = require('../src/admin/lib/native-image-compression-policy.cjs');
const uploadPolicy = require('../src/admin/lib/native-image-upload-policy.cjs');

const root = resolve(__dirname, '..');
const dashboardRoot = resolve(root, 'node_modules/@medusajs/dashboard');
const readDashboard = (file) => readFileSync(resolve(dashboardRoot, 'dist', file), 'utf8');

test('native upload audit stays pinned to the reviewed Medusa Dashboard implementation', () => {
  const version = require('../node_modules/@medusajs/dashboard/package.json').version;
  const source = readDashboard('chunk-QR6FHSFY.mjs');
  assert.equal(version, SUPPORTED_DASHBOARD_VERSION);
  assert.match(source, /DEFAULT_MAX_FILE_SIZE = __MAX_UPLOAD_FILE_SIZE__ \?\? 1024 \* 1024/);
  assert.match(source, /if \(file\.size > normalizedMaxFileSize\)/);
});

test('files under 1 MB bypass compression and supported large formats keep their MIME type', async () => {
  const source = readFileSync(resolve(root, 'src/admin/lib/native-image-compression.ts'), 'utf8');
  assert.match(source, /new File\(\[blob\], original\.name/);
  assert.match(source, /type: original\.type/);
  assert.doesNotMatch(source, /image\/webp['"],\s*quality/);
  const small = { name: 'small.jpg', type: 'image/jpeg', size: 900_000 };
  let encodeCalls = 0;
  const result = await compressionPolicy.compressToLimit(
    small,
    { width: 2000, height: 1000 },
    async () => { encodeCalls += 1; },
    () => { throw new Error('small images must not be rebuilt'); },
  );
  assert.equal(result, small);
  assert.equal(encodeCalls, 0);
});

test('large images reach the 0.9 MB target with quality first and dimensions only as needed', async () => {
  const large = { name: 'large.jpg', type: 'image/jpeg', size: 4_000_000 };
  const attempts = [];
  const result = await compressionPolicy.compressToLimit(
    large,
    { width: 3000, height: 2000 },
    async (attempt) => {
      attempts.push(attempt);
      return { type: large.type, size: attempts.length < 9 ? 1_200_000 : 900_000 };
    },
    (blob, original) => ({ ...original, size: blob.size }),
  );
  assert.equal(result.size, 900_000);
  assert.ok(result.size <= compressionPolicy.NATIVE_UPLOAD_TARGET_BYTES);
  assert.equal(attempts[0].width, 3000);
  assert.equal(attempts[0].quality, 0.94);
  assert.equal(attempts[6].width, 3000);
  assert.ok(attempts[7].width < 3000, 'dimensions should drop only after full-resolution quality steps');
});

test('multi-file preparation is sequential and isolates failures including unsafe AVIF', () => {
  const source = readFileSync(resolve(root, 'src/admin/lib/native-image-compression.ts'), 'utf8');
  const policySource = readFileSync(resolve(root, 'src/admin/lib/native-image-compression-policy.cjs'), 'utf8');
  assert.match(source, /for \(const file of input\)/);
  assert.match(source, /files\.push\(prepared\)/);
  assert.match(source, /failures\.push/);
  assert.match(policySource, /AVIF was kept unchanged/);
  assert.match(source, /could not be prepared/);
});

test('build patch compresses before native validation and keeps valid siblings', () => {
  const patched = patchFileUpload(readDashboard('chunk-QR6FHSFY.mjs'));
  assert.match(patched, /await prepareNativeImageFiles\(fileList, normalizedMaxFileSize\)/);
  assert.match(patched, /prepared\.files\.forEach/);
  assert.match(patched, /onUploaded\(validFiles, \[\]\)/);
  assert.doesNotMatch(patched, /if \(file\.size > normalizedMaxFileSize\)/);
});

test('edit and create uploads are split per file with per-file failure lists', () => {
  const media = patchProductMediaUpload(readDashboard('product-media-72TTTVV5.mjs'));
  const create = patchProductCreateUpload(readDashboard('product-create-BGKDACMU.mjs'));
  for (const patched of [media, create]) {
    assert.match(patched, /uploadSequentially/);
    assert.match(patched, /create\(\{ files: \[item\.file\] \}\)/);
    assert.match(patched, /if \(uploadFailures\.length\)/);
    assert.match(patched, /failed to upload/);
    assert.match(patched, /return;/);
  }
  assert.match(media, /buildProductMedia\(media, uploadedByIndex\)/);
  assert.doesNotMatch(create, /Promise\.all\(fileReqs\)/);
});

test('native save controls stay blocked for the entire upload and product-submit operation', () => {
  const media = patchProductMediaSubmittingState(patchProductMediaUpload(readDashboard('product-media-72TTTVV5.mjs')));
  const create = patchProductCreateSubmittingState(patchProductCreateUpload(readDashboard('product-create-BGKDACMU.mjs')));
  assert.match(media, /isLoading: isPending \|\| form\.formState\.isSubmitting/);
  assert.match(media, /disabled: form\.formState\.isSubmitting/);
  assert.match(create, /isLoading: isPending \|\| form\.formState\.isSubmitting/);
  assert.match(create, /disabled: form\.formState\.isSubmitting/);
});

test('small files upload unchanged and large files upload only after compression', async () => {
  const small = { name: 'small.jpg', type: 'image/jpeg', size: 800_000 };
  const large = { name: 'large.jpg', type: 'image/jpeg', size: 4_000_000 };
  const preparedSmall = await compressionPolicy.compressToLimit(
    small,
    { width: 1, height: 1 },
    async () => { throw new Error('small file must not be encoded'); },
    () => {}
  );
  const preparedLarge = await compressionPolicy.compressToLimit(
    large,
    { width: 2000, height: 1000 },
    async () => ({ type: 'image/jpeg', size: 850_000 }),
    (blob, original) => ({ ...original, size: blob.size, compressed: true })
  );
  const seen = [];
  const result = await uploadPolicy.uploadSequentially([
    { index: 0, file: preparedSmall },
    { index: 1, file: preparedLarge },
  ], async (item) => {
    seen.push(item.file);
    return { url: `https://uploads.example/${item.file.name}` };
  });
  assert.equal(seen[0], small);
  assert.equal(seen[1].compressed, true);
  assert.deepEqual(result.failures, []);
});

test('mixed uploads are sequential and one failure prevents a final product payload', async () => {
  const active = { current: 0, peak: 0 };
  const items = ['one.jpg', 'two.jpg', 'three.jpg'].map((name, index) => ({ index, file: { name } }));
  const result = await uploadPolicy.uploadSequentially(items, async (item) => {
    active.current += 1;
    active.peak = Math.max(active.peak, active.current);
    await Promise.resolve();
    active.current -= 1;
    if (item.index === 1) throw new Error('network failed');
    return { url: `https://uploads.example/${item.file.name}` };
  });
  assert.equal(active.peak, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].item.file.name, 'two.jpg');
  assert.throws(() => uploadPolicy.buildProductMedia(items, result.uploadedByIndex), /has not finished uploading/);
});

test('final product media contains only non-empty HTTP(S) URLs and never preview objects', async () => {
  const media = [
    { id: 'existing', url: 'https://cdn.example/existing.jpg', file: null },
    { id: 'preview', url: 'blob:local-preview', file: { name: 'new.jpg' } },
  ];
  const result = await uploadPolicy.uploadSequentially(
    [{ index: 1, file: media[1].file }],
    async () => ({ id: 'uploaded', url: 'https://uploads.example/new.jpg' })
  );
  const payload = uploadPolicy.buildProductMedia(media, result.uploadedByIndex)
    .map((item) => ({ url: item.url, id: item.id }));
  assert.deepEqual(payload, [
    { url: 'https://cdn.example/existing.jpg', id: 'existing' },
    { url: 'https://uploads.example/new.jpg', id: 'uploaded' },
  ]);
  assert.ok(payload.every((item) => /^https?:\/\//.test(item.url)));
  assert.throws(() => uploadPolicy.buildProductMedia([{ url: 'blob:preview' }], new Map()), /has not finished uploading/);
  assert.throws(() => uploadPolicy.buildProductMedia([{ url: '', file: {} }], new Map()), /has not finished uploading/);
});

test('an empty URL from the upload API never falls back to a preview or stale URL', () => {
  // Regression: `uploaded?.url || entry.url` used to treat an empty-string
  // upload URL as falsy and silently fall back to the entry's blob preview URL
  // (or a stale existing URL). An empty upload URL must now be rejected.
  const media = [{ id: 'new', url: 'blob:local-preview', file: { name: 'new.jpg' } }];
  const uploadedByIndex = new Map([[0, { id: 'uploaded', url: '' }]]);
  assert.throws(
    () => uploadPolicy.buildProductMedia(media, uploadedByIndex),
    /has not finished uploading/
  );

  // A stale existing URL must not mask a missing upload URL either.
  const staleMedia = [{ id: 'new', url: 'https://cdn.example/stale.jpg', file: { name: 'new.jpg' } }];
  assert.throws(
    () => uploadPolicy.buildProductMedia(staleMedia, new Map([[0, { id: 'u', url: '' }]])),
    /has not finished uploading/
  );
});

test('buildProductMedia asserts every image URL is a non-empty HTTP(S) URL', () => {
  // Every invalid URL — undefined, non-http, blob — is rejected before it can
  // reach the final payload. The per-entry check throws first.
  assert.throws(
    () => uploadPolicy.buildProductMedia([{ url: undefined, file: null }], new Map()),
    /has not finished uploading/
  );
  assert.throws(
    () => uploadPolicy.buildProductMedia([{ url: 'data:image/png;base64,xxxx', file: null }], new Map()),
    /has not finished uploading/
  );
  assert.throws(
    () => uploadPolicy.buildProductMedia([{ url: 'blob:local', file: null }], new Map()),
    /has not finished uploading/
  );
  // A valid pre-existing image still passes both the per-entry check and the
  // final payload assertion.
  const ok = uploadPolicy.buildProductMedia([{ url: 'https://cdn.example/a.jpg', file: null }], new Map());
  assert.equal(ok[0].url, 'https://cdn.example/a.jpg');
});
