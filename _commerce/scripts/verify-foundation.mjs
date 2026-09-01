import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensurePrivateRuntime } = require('./private-runtime.cjs');
const runtime = ensurePrivateRuntime();
const psql = '/opt/homebrew/opt/postgresql@17/bin/psql';
const databaseArgs = ['-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', '-d', 'pawshop_dev', '-At'];
const databaseEnv = { ...process.env, PGPASSWORD: runtime.env.POSTGRES_PASSWORD };

function query(sql) {
  return execFileSync(psql, [...databaseArgs, '-c', sql], { env: databaseEnv, encoding: 'utf8' }).trim();
}

for (const [table, expected] of [['customer', '0'], ['order', '0'], ['region', '0'], ['product', '1']]) {
  const quoted = table === 'order' ? '"order"' : table;
  const count = query(`SELECT count(*) FROM ${quoted};`);
  if (count !== expected) throw new Error(`${table} count is ${count}; expected ${expected}.`);
}

const token = query("SELECT token FROM api_key WHERE type='publishable' AND revoked_at IS NULL LIMIT 1;");
if (!token) throw new Error('The local Medusa publishable-key fixture is missing.');

async function expectStatus(method, path, status, headers = {}) {
  const response = await fetch(`http://127.0.0.1:9000${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'POST' ? '{}' : undefined,
  });
  if (response.status !== status) throw new Error(`${method} ${path} returned ${response.status}; expected ${status}.`);
}

await expectStatus('GET', '/health', 200);
await expectStatus('GET', '/app', 200);
await expectStatus('GET', '/admin/products', 401);
await expectStatus('GET', '/store/products', 503, { 'x-publishable-api-key': token });
await expectStatus('POST', '/store/carts', 503, { 'x-publishable-api-key': token });
await expectStatus('POST', '/auth/customer/emailpass/register', 503);
console.log('Foundation verification passed: admin login is local, public commerce and customer routes are closed.');
