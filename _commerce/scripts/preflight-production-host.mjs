import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseMemTotal, assertProductionHost } = require('./production-host-policy.cjs');

if (process.platform !== 'linux') throw new Error('Production host preflight must run on Linux.');
const memoryKib = parseMemTotal(readFileSync('/proc/meminfo', 'utf8'));
const diskLine = execFileSync('df', ['-Pk', process.cwd()], { encoding: 'utf8' }).trim().split('\n').at(-1);
const availableDiskKib = Number(diskLine.trim().split(/\s+/)[3]);
assertProductionHost({ memoryKib, availableDiskKib });

for (const command of ['nginx', 'node', 'npm', 'psql', 'pg_dump', 'redis-cli', 'systemctl', 'ss', 'curl', 'openssl', 'tar']) {
  try {
    execFileSync('sh', ['-c', 'command -v "$1" >/dev/null', 'preflight', command], { stdio: 'ignore' });
  } catch {
    throw new Error(`Production host is missing required command: ${command}`);
  }
}

console.log('Production host preflight passed.');
