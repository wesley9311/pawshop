'use strict';

const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, lstatSync, readlinkSync } = require('node:fs');
const { join, relative, sep, resolve, dirname, isAbsolute } = require('node:path');

const RELEASE_ID = /^[0-9a-f]{40}$/;

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function releaseFiles(root) {
  const files = [];
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path).split(sep).join('/');
      if (!rel || rel.startsWith('../') || /[\0\r\n]/.test(rel)) {
        throw new Error('Release contains an unsafe path.');
      }
      const stat = lstatSync(path);
      const mode = stat.mode & 0o777;
      if (stat.isDirectory()) {
        files.push({ path: rel, type: 'directory', mode });
        walk(path);
      }
      else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        const resolvedTarget = resolve(dirname(path), target);
        if (isAbsolute(target) || (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`))) {
          throw new Error('Release contains a symbolic link outside the candidate root.');
        }
        files.push({ path: rel, type: 'symlink', mode, target, sha256: sha256(target) });
      }
      else if (stat.isFile() && rel !== '.pawshop-release.json') files.push({ path: rel, type: 'file', mode, sha256: sha256(readFileSync(path)) });
      else if (!stat.isFile()) throw new Error('Release contains an unsupported filesystem entry.');
    }
  };
  walk(root);
  return files;
}

function contentSha256(files) {
  return sha256(JSON.stringify(files));
}

function assertReleaseManifest(manifest, { releaseId, treeId, packageLockSha256, files }) {
  const keys = ['schema', 'release_id', 'git_tree', 'package_lock_sha256', 'content_sha256', 'files'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      Object.keys(manifest).sort().join('\0') !== keys.sort().join('\0')) throw new Error('Release manifest fields are invalid.');
  if (!RELEASE_ID.test(releaseId) || manifest.schema !== 'pawshop-prepared-release-v1' ||
      manifest.release_id !== releaseId || manifest.git_tree !== treeId ||
      manifest.package_lock_sha256 !== packageLockSha256 ||
      JSON.stringify(manifest.files) !== JSON.stringify(files) ||
      manifest.content_sha256 !== contentSha256(files)) throw new Error('Prepared release content does not match its manifest.');
}

module.exports = { RELEASE_ID, sha256, releaseFiles, contentSha256, assertReleaseManifest };
