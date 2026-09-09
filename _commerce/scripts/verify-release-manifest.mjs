import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RELEASE_ID, sha256, releaseFiles, assertReleaseManifest } = require('./release-manifest.cjs');
const root = resolve(process.argv[2] || '');
const releaseId = process.argv[3];
if (!RELEASE_ID.test(releaseId || '')) throw new Error('Release verification requires an exact commit identity.');
const source = readFileSync(join(root, '.pawshop-release.json'), 'utf8');
if (Buffer.byteLength(source, 'utf8') > 64 * 1024 * 1024 || source.includes('\0')) throw new Error('Release manifest has an unsafe format.');
let manifest;
try { manifest = JSON.parse(source); } catch { throw new Error('Release manifest is not valid JSON.'); }
assertReleaseManifest(manifest, {
  releaseId, treeId: manifest.git_tree,
  packageLockSha256: sha256(readFileSync(join(root, '_commerce/package-lock.json'))),
  files: releaseFiles(root),
});
console.log(manifest.content_sha256);
