import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensurePrivateRuntime } = require('./private-runtime.cjs');
const { validateLocalEnvironment } = require('../src/lib/local-policy.cjs');
const runtime = ensurePrivateRuntime();
const env = { ...process.env, ...runtime.env, NODE_ENV: 'development', MEDUSA_DISABLE_TELEMETRY: 'true' };
validateLocalEnvironment(env);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (runtime.admin.ADMIN_EMAIL !== 'owner@pawshop.local' || !/^.{24,}$/.test(runtime.admin.ADMIN_PASSWORD || '')) {
  throw new Error('Local administrator credential file is malformed.');
}

const existing = execFileSync('/opt/homebrew/opt/postgresql@17/bin/psql', [
  '-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', '-d', 'pawshop_dev',
  '-tAc', `SELECT count(*) FROM "user" WHERE email = '${runtime.admin.ADMIN_EMAIL}'`,
], { env: { ...env, PGPASSWORD: runtime.env.POSTGRES_PASSWORD }, encoding: 'utf8' }).trim();
if (existing === '1') {
  console.log(`Local owner account already exists. Credentials remain in: ${runtime.adminFile}`);
  process.exit(0);
}
if (existing !== '0') throw new Error(`Unexpected local owner account count: ${existing}`);

execFileSync(join(root, 'node_modules', '.bin', 'medusa'), [
  'user', '-e', runtime.admin.ADMIN_EMAIL, '-p', runtime.admin.ADMIN_PASSWORD,
], { cwd: root, env, stdio: 'inherit' });
console.log(`Local owner account is ready. Credentials remain in: ${runtime.adminFile}`);
