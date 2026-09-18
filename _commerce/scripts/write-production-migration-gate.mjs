import { execFileSync } from 'node:child_process';
import {
  chmodSync, chownSync, closeSync, constants, fsyncSync, lstatSync, openSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertProductionEnvironmentFileStat, parseProductionEnvironmentFile } = require('./production-env-file.cjs');

if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 6) {
  throw new Error('Production migration gate changes require root on Linux and an exact release identity.');
}
const release = resolve(process.argv[2] || '');
const releaseId = process.argv[3];
const contentSha256 = process.argv[4];
const action = process.argv[5];
// `enable` closes the gate for a release whose evidence is complete. The two
// opening actions close nothing: `open-upgrade` opens the window in which an
// existing database may be migrated onto a new release, and `rollback-disable`
// returns the gate to its fail-closed state after a failed activation.
const GATE_ACTIONS = ['enable', 'rollback-disable', 'open-upgrade'];

if (!/^[0-9a-f]{40}$/.test(releaseId || '') || !/^[0-9a-f]{64}$/.test(contentSha256 || '') ||
    release !== `/srv/pawshop-commerce/releases/${releaseId}` || !GATE_ACTIONS.includes(action)) {
  throw new Error('Production migration gate arguments are invalid.');
}
const verifiedContent = execFileSync('/usr/bin/node', [
  join(release, '_commerce/scripts/verify-release-manifest.mjs'), release, releaseId,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
if (verifiedContent !== contentSha256) throw new Error('The production migration gate release digest does not match.');
if (action === 'enable') {
  execFileSync('/usr/bin/node', [
    join(release, '_commerce/scripts/verify-release-evidence.mjs'), releaseId, contentSha256,
  ], { stdio: 'ignore' });
}

const environmentPath = '/etc/pawshop/commerce.env';
const pawshopGid = Number(execFileSync('/usr/bin/id', ['-g', 'pawshop'], { encoding: 'utf8' }).trim());
assertProductionEnvironmentFileStat(lstatSync(environmentPath), pawshopGid);
const source = readFileSync(environmentPath, 'utf8');
const parsed = parseProductionEnvironmentFile(source);
const from = action === 'enable' ? '0' : '1';
const to = action === 'enable' ? '1' : '0';
if (parsed.PAWSHOP_MIGRATIONS_CONFIRMED !== from) {
  throw new Error(`Production migration gate must be ${from} before ${action}.`);
}
const updated = source.replace(new RegExp(`^PAWSHOP_MIGRATIONS_CONFIRMED=${from}$`, 'm'),
  `PAWSHOP_MIGRATIONS_CONFIRMED=${to}`);
if (updated === source || parseProductionEnvironmentFile(updated).PAWSHOP_MIGRATIONS_CONFIRMED !== to) {
  throw new Error('Production migration gate could not be changed without altering the environment contract.');
}

const temporary = `/etc/pawshop/.commerce.env.gate.${process.pid}`;
let descriptor;
let directoryDescriptor;
try {
  descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  writeFileSync(descriptor, updated, { encoding: 'utf8' });
  fsyncSync(descriptor);
  closeSync(descriptor);
  descriptor = undefined;
  chownSync(temporary, 0, pawshopGid);
  chmodSync(temporary, 0o640);
  renameSync(temporary, environmentPath);
  directoryDescriptor = openSync('/etc/pawshop', constants.O_RDONLY | constants.O_DIRECTORY);
  fsyncSync(directoryDescriptor);
} finally {
  if (descriptor !== undefined) closeSync(descriptor);
  if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  rmSync(temporary, { force: true });
}
const GATE_MESSAGES = {
  enable: 'Production migration gate enabled for the exact evidence-backed release.',
  'rollback-disable': 'Production migration gate returned to fail-closed state after unsuccessful first activation.',
  'open-upgrade': 'Production migration gate opened for an upgrade of the running production database.',
};
console.log(GATE_MESSAGES[action]);
