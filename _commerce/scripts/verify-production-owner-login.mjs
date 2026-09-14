import { execFileSync } from 'node:child_process';
import { constants, closeSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseProductionEnvironmentFile } = require('./production-env-file.cjs');

if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 4) {
  throw new Error('Production owner login verification requires root on Linux and an exact release identity.');
}
const release = resolve(process.argv[2] || '');
const releaseId = process.argv[3];
if (!/^[0-9a-f]{40}$/.test(releaseId || '') || release !== `/srv/pawshop-commerce/releases/${releaseId}`) {
  throw new Error('Production owner verification release identity is invalid.');
}

function privateSource(path, { gid = 0, mode = 0o600, maximum = 64 * 1024, label }) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== gid ||
      (stat.mode & 0o777) !== mode || stat.size <= 0 || stat.size > maximum) {
    throw new Error(`${label} has unsafe ownership, type, permissions, or size.`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(descriptor, 'utf8'); } finally { closeSync(descriptor); }
}
const pawshopGid = Number(execFileSync('/usr/bin/id', ['-g', 'pawshop'], { encoding: 'utf8' }).trim());
let credentials;
try {
  credentials = JSON.parse(privateSource('/root/pawshop-production-owner-credentials.json', {
    label: 'Owner credentials', maximum: 4096,
  }));
} catch { throw new Error('Production owner credentials are invalid or unreadable.'); }
if (!credentials || Object.keys(credentials).sort().join('\0') !== 'email\0password' ||
    typeof credentials.email !== 'string' || typeof credentials.password !== 'string') {
  throw new Error('Production owner credentials do not match the approved contract.');
}
const environment = parseProductionEnvironmentFile(privateSource('/etc/pawshop/commerce.env', {
  gid: pawshopGid, mode: 0o640, label: 'Production environment',
}));
if (environment.PAWSHOP_MIGRATIONS_CONFIRMED !== '1' || environment.PAWSHOP_MODE !== 'production-admin-only') {
  throw new Error('Production owner login verification requires the activated admin-only environment.');
}
const origin = `http://127.0.0.1:${environment.PORT}`;
async function jsonResponse(path, options, expectedStatus = 200) {
  const response = await fetch(`${origin}${path}`, {
    redirect: 'manual', signal: AbortSignal.timeout(8000), ...options,
  });
  const source = await response.text();
  if (response.status !== expectedStatus || source.length > 1024 * 1024) {
    throw new Error(`${path} did not return the expected bounded response.`);
  }
  try { return JSON.parse(source); } catch { throw new Error(`${path} did not return valid JSON.`); }
}
const login = await jsonResponse('/auth/user/emailpass', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: credentials.email, password: credentials.password }),
});
if (!login || typeof login.token !== 'string' || login.token.length < 32 || login.token.length > 8192) {
  throw new Error('Production owner authentication did not return a valid token.');
}
const headers = { authorization: `Bearer ${login.token}` };
const me = await jsonResponse('/admin/users/me?fields=id,email', { headers });
if (!me?.user?.id || me.user.email !== credentials.email) {
  throw new Error('Authenticated production owner identity does not match the provisioned account.');
}
for (const [path, field] of [
  ['/admin/products?limit=1', 'products'], ['/admin/orders?limit=1', 'orders'],
  ['/admin/customers?limit=1', 'customers'],
]) {
  const result = await jsonResponse(path, { headers });
  if (!Array.isArray(result?.[field])) throw new Error(`Authenticated ${field} management response is malformed.`);
}
console.log('Production owner login and authenticated product, order, and customer management access passed.');
