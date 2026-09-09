import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RELEASE_ID, sha256, releaseFiles, contentSha256 } = require('./release-manifest.cjs');
const root = resolve(process.argv[2] || '');
const releaseId = process.argv[3];
const gitTree = process.argv[4];
if (!RELEASE_ID.test(releaseId || '') || !/^[0-9a-f]{40}$/.test(gitTree || '')) {
  throw new Error('Release manifest requires exact commit and tree identities.');
}
const packageLock = readFileSync(join(root, '_commerce/package-lock.json'));
const files = releaseFiles(root);
const manifest = {
  schema: 'pawshop-prepared-release-v1', release_id: releaseId, git_tree: gitTree,
  package_lock_sha256: sha256(packageLock), content_sha256: contentSha256(files), files,
};
writeFileSync(join(root, '.pawshop-release.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
