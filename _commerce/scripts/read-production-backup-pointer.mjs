import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 2) {
  throw new Error('The production backup pointer may only be read by root on Linux.');
}
const backupUid = Number(execFileSync('/usr/bin/id', ['-u', 'pawshop-backup'], { encoding: 'utf8' }).trim());
const backupGid = Number(execFileSync('/usr/bin/id', ['-g', 'pawshop-backup'], { encoding: 'utf8' }).trim());
const pointerPath = join('/var/backups/pawshop', 'latest.json');
const stat = lstatSync(pointerPath);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== backupUid || stat.gid !== backupGid ||
    (stat.mode & 0o777) !== 0o600 || stat.size <= 0 || stat.size > 4096) {
  throw new Error('The latest production backup pointer has unsafe ownership, type, permissions, or size.');
}
let pointer;
try { pointer = JSON.parse(readFileSync(pointerPath, 'utf8')); }
catch { throw new Error('The latest production backup pointer is invalid JSON.'); }
if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer) ||
    Object.keys(pointer).join('\0') !== 'manifest_file' ||
    !/^pawshop_production_[0-9]{8}T[0-9]{9}Z\.manifest\.json$/.test(pointer.manifest_file || '')) {
  throw new Error('The latest production backup pointer is unsafe.');
}
console.log(pointer.manifest_file);
