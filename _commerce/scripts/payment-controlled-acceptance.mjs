// Controlled fixtures only, in a newly created loopback database. No production
// configuration, PayPal credentials, network funds, or existing database writes.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

if (![22, 24].includes(Number(process.versions.node.split('.')[0]))) throw new Error('Use Node 22 or 24.');
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const localEnv = parseEnv(readFileSync(join(homedir(), 'Documents/PawShop_Private/development/commerce.env'), 'utf8'));
const database = new URL(localEnv.DATABASE_URL);
if (database.hostname !== '127.0.0.1' || database.port !== '54329' || database.pathname !== '/pawshop_dev') {
  throw new Error('The dedicated local database configuration is required.');
}
const name = 'pawshop_payment_acceptance_' + randomBytes(6).toString('hex');
const root = mkdtempSync(join(tmpdir(), 'pawshop-payment-acceptance-'));
mkdirSync(join(root, 'src/scripts'), { recursive: true });
mkdirSync(join(root, 'src/modules'), { recursive: true });
symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'));
symlinkSync(join(source, 'src/lib'), join(root, 'src/lib'));
for (const module of ['paypal', 'pawshop-payment-reconciliation', 'pawshop-payment']) {
  symlinkSync(join(source, 'src/modules', module), join(root, 'src/modules', module));
}
copyFileSync(join(source, 'tsconfig.json'), join(root, 'tsconfig.json'));
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pawshop-controlled-payment-test', version: '1.0.0', dependencies: { '@medusajs/medusa': '2.21.0' } }));
writeFileSync(join(root, 'medusa-config.ts'), `import { defineConfig } from '@medusajs/framework/utils'
module.exports = defineConfig({
 projectConfig: { databaseUrl: process.env.DATABASE_URL, http: { jwtSecret: 'controlled-only', cookieSecret: 'controlled-only', storeCors: '', adminCors: '', authCors: '' } },
 admin: { disable: true }, modules: [
 { resolve: '@medusajs/medusa/fulfillment', options: { providers: [{resolve: '@medusajs/medusa/fulfillment-manual', id: 'manual'}] } },
 { resolve: './src/modules/pawshop-payment', options: { providers: [{resolve: './src/modules/paypal', id: 'paypal', options: {client_id: 'controlled', client_secret: 'controlled', sandbox: true, webhook_id: 'controlled', return_url: 'https://pawlivora.com', cancel_url: 'https://pawlivora.com'}}] } },
 { resolve: './src/modules/pawshop-payment-reconciliation' }
 ]
})`);
const fixture = readFileSync(join(source, 'tests/payment-controlled-acceptance.ts'), 'utf8').replaceAll("from '../src/lib/", "from '../lib/");
writeFileSync(join(root, 'src/scripts/acceptance.ts'), fixture);
const pgBin = process.env.PAWSHOP_CONTROLLED_PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const created = spawnSync(join(pgBin, 'createdb'), ['-h', database.hostname, '-p', database.port, '-U', decodeURIComponent(database.username), name], {
  env: { ...process.env, PGPASSWORD: decodeURIComponent(database.password) }, encoding: 'utf8',
});
if (created.status !== 0) throw new Error('Could not create the isolated acceptance database.');
database.pathname = '/' + name;
const env = {
  PATH: dirname(process.execPath) + ':' + process.env.PATH,
  HOME: homedir(), DATABASE_URL: database.toString(), MEDUSA_DISABLE_TELEMETRY: 'true',
  NODE_ENV: 'development',
};
for (const [label, args] of [['migrate', ['db:migrate']], ['acceptance', ['exec', './src/scripts/acceptance.ts']]]) {
  const result = spawnSync(join(root, 'node_modules/.bin/medusa'), args, { cwd: root, env, encoding: 'utf8' });
  writeFileSync(join(root, label + '.log'), (result.stdout || '') + (result.stderr || ''), { mode: 0o600 });
  if (result.status !== 0) throw new Error(`${label} failed; evidence retained at ${root}`);
}
const facts = spawnSync(join(pgBin, 'psql'), ['--no-psqlrc', '-h', database.hostname, '-p', database.port, '-U', decodeURIComponent(database.username), '-d', name, '-f', join(source, 'scripts/commerce-facts.sql')], {
  env: { PATH: env.PATH, PGPASSWORD: decodeURIComponent(database.password) }, encoding: 'utf8',
});
writeFileSync(join(root, 'commerce-facts.log'), (facts.stdout || '') + (facts.stderr || ''), { mode: 0o600 });
if (facts.status !== 0) throw new Error(`Commerce facts failed; evidence retained at ${root}`);
const lines = facts.stdout.split('\n');
const header = lines.findIndex((line) => line.includes('captured_orders') && line.includes('net_revenue'));
const columns = lines[header].split('|').map((value) => value.trim());
const values = lines[header + 2].split('|').map((value) => value.trim());
const metrics = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
assert.equal(Number(metrics.captured_orders), 1);
assert.equal(Number(metrics.captured_revenue), 25);
assert.equal(Number(metrics.refund), 5);
assert.equal(Number(metrics.net_revenue), 20);
console.log('CONTROLLED VERIFIED: Medusa capture, five route gates, reconciliation hold, external refund adoption.');
console.log('Evidence:', root);
console.log('Isolated database retained:', name);
