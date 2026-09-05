import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensurePrivateRuntime } = require('./private-runtime.cjs');
const { expectHttpStatus } = require('./http-probe.cjs');
const runtime = ensurePrivateRuntime();
const psql = '/opt/homebrew/opt/postgresql@17/bin/psql';
const databaseArgs = ['-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', '-d', 'pawshop_dev', '-At'];
const databaseEnv = {
  ...process.env,
  PGPASSWORD: runtime.env.POSTGRES_PASSWORD,
  PGCONNECT_TIMEOUT: '3',
  PGOPTIONS: '-c statement_timeout=4000',
};

function query(sql) {
  try {
    return execFileSync(psql, [...databaseArgs, '-c', sql], {
      env: databaseEnv, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error('Foundation database probe failed or exceeded 5000ms; check the private local PostgreSQL service.');
  }
}

for (const [table, expected] of [['customer', '0'], ['order', '0'], ['region', '0'], ['product', '1']]) {
  const quoted = table === 'order' ? '"order"' : table;
  const count = query(`SELECT count(*) FROM ${quoted};`);
  if (count !== expected) throw new Error(`${table} count is ${count}; expected ${expected}.`);
}

const token = query("SELECT token FROM api_key WHERE type='publishable' AND revoked_at IS NULL LIMIT 1;");
if (!token) throw new Error('The local Medusa publishable-key fixture is missing.');

async function expectStatus(method, path, status, headers = {}) {
  try {
    await expectHttpStatus(`http://127.0.0.1:9000${path}`, { method, status, headers });
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

await expectStatus('GET', '/health', 200);
await expectStatus('GET', '/app', 200);
await expectStatus('GET', '/admin/products', 401);
await expectStatus('GET', '/store/products', 503, { 'x-publishable-api-key': token });
await expectStatus('POST', '/store/carts', 503, { 'x-publishable-api-key': token });
await expectStatus('POST', '/auth/customer/emailpass/register', 503);
console.log('Foundation verification passed: local admin API requires authentication; public commerce and customer routes are closed.');
