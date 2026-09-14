import { lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertProductionEnvironmentFileStat, parseProductionEnvironmentFile } = require('./production-env-file.cjs');

if (process.platform !== 'linux' || process.getuid() === 0 || process.argv.length !== 2) {
  throw new Error('Production admin verification must run as the unprivileged PawShop service account.');
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!/^\/srv\/pawshop-commerce\/releases\/[0-9a-f]{40}\/_commerce$/.test(root)) {
  throw new Error('Production admin verification must run from an exact immutable release.');
}
const environmentPath = '/etc/pawshop/commerce.env';
assertProductionEnvironmentFileStat(lstatSync(environmentPath), process.getgid());
const environment = parseProductionEnvironmentFile(readFileSync(environmentPath, 'utf8'));
if (environment.PAWSHOP_MIGRATIONS_CONFIRMED !== '1') {
  throw new Error('Production admin verification requires the enabled migration gate.');
}
Object.assign(process.env, environment, { HOME: '/var/lib/pawshop', MEDUSA_DISABLE_TELEMETRY: 'true' });
await import('./verify-production-admin.mjs');
