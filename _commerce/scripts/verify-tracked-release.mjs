import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = process.argv[2];
const candidate = process.argv[3];
const releaseId = process.argv[4];
if (source !== '/srv/pawshop-source' || !/^[0-9a-f]{40}$/.test(releaseId || '') ||
    (candidate !== `/srv/pawshop-commerce/releases/${releaseId}` &&
     candidate !== `/srv/pawshop-commerce/releases/.${releaseId}.staging`)) {
  throw new Error('Tracked release verification received an unsafe path or identity.');
}

const listed = spawnSync('/usr/bin/git', [
  '-c', `safe.directory=${source}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-C', source, 'ls-tree', '-rz', '--full-tree', releaseId, '--', '_commerce', 'ops/commerce',
], { encoding: 'buffer', env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' } });
if (listed.status !== 0 || listed.stderr.length) throw new Error('Could not enumerate the trusted release tree.');

let checked = 0;
for (const record of listed.stdout.toString('utf8').split('\0')) {
  if (!record) continue;
  const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t([^\0\r\n]+)$/.exec(record);
  if (!match) throw new Error('The trusted release contains an unsupported Git entry.');
  const [, mode, expectedObject, path] = match;
  const target = join(candidate, path);
  const stat = lstatSync(target);
  let bytes;
  if (mode === '120000') {
    if (!stat.isSymbolicLink()) throw new Error('A tracked release symlink changed type.');
    bytes = Buffer.from(readlinkSync(target));
  } else {
    if (!stat.isFile() || stat.isSymbolicLink() || ((stat.mode & 0o111) !== 0) !== (mode === '100755')) {
      throw new Error('A tracked release file changed type or executable mode.');
    }
    bytes = readFileSync(target);
  }
  const header = Buffer.from(`blob ${bytes.length}\0`);
  const actualObject = createHash('sha1').update(header).update(bytes).digest('hex');
  if (actualObject !== expectedObject) throw new Error(`A tracked release file was modified during build: ${path}`);
  checked += 1;
}
if (checked < 1) throw new Error('The trusted release tree was empty.');
console.log(`Verified ${checked} tracked release entries.`);
