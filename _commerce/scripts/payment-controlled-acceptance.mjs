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
function query(text) {
 const r=spawnSync(join(pgBin,'psql'),['--no-psqlrc','-h',database.hostname,'-p',database.port,'-U',decodeURIComponent(database.username),'-d',name,'-v','ON_ERROR_STOP=1','-c',text],{env:{PATH:env.PATH,PGPASSWORD:decodeURIComponent(database.password)},encoding:'utf8'});
 if(r.status!==0)throw Error('Scratch query failed');return r.stdout;
}
function runFacts(environment, expected) {
 const r=spawnSync(join(pgBin,'psql'),['--no-psqlrc','-h',database.hostname,'-p',database.port,'-U',decodeURIComponent(database.username),'-d',name,'-v','ON_ERROR_STOP=1',...(environment?['-v','payment_environment='+environment]:[]),'-f',join(source,'scripts/commerce-facts.sql')],{env:{PATH:env.PATH,PGPASSWORD:decodeURIComponent(database.password)},encoding:'utf8'});
 writeFileSync(join(root,'commerce-facts-'+(environment||'default-live')+'-'+expected+'.log'),r.stdout+r.stderr,{mode:0o600});if(r.status!==0)throw Error('Commerce fact SQL failed');
 const lines=r.stdout.split('\n'),h=lines.findIndex(l=>l.includes('captured_orders')&&l.includes('net_revenue'));
 if(expected===0){assert.match(lines[h+2],/^\(0 /);assert.match(r.stdout,/dimension_type/);return;}
 const cols=lines[h].split('|').map(x=>x.trim()),vals=lines[h+2].split('|').map(x=>x.trim()),m=Object.fromEntries(cols.map((k,i)=>[k,vals[i]]));
 assert.equal(Number(m.captured_orders),1);assert.equal(Number(m.captured_revenue),25);assert.equal(Number(m.refund),5);assert.equal(Number(m.net_revenue),20);
}
runFacts(undefined,0);runFacts('sandbox',1);
// Only this newly created loopback fixture DB. No remote APIs run after these changes.
query(`BEGIN; UPDATE payment_session SET data=data||'{"paypal_environment":"live"}'::jsonb||jsonb_build_object('approval_url','https://www.paypal.com/checkoutnow?token='||(data->>'id')) WHERE provider_id='pp_paypal_paypal'; UPDATE payment SET data=data||'{"paypal_environment":"live"}'::jsonb||jsonb_build_object('approval_url','https://www.paypal.com/checkoutnow?token='||(data->>'id')) WHERE provider_id='pp_paypal_paypal'; COMMIT;`);
runFacts(undefined,1);runFacts('sandbox',0);
query(`UPDATE payment SET data=data||'{"paypal_environment":"sandbox"}'::jsonb WHERE provider_id='pp_paypal_paypal';`);runFacts(undefined,0);runFacts('sandbox',0);
query(`UPDATE payment SET data=data-'paypal_environment' WHERE provider_id='pp_paypal_paypal';`);runFacts(undefined,0);
console.log('CONTROLLED VERIFIED: capture, five fulfillment gates, external refund adoption, real module webhook environment checks, immutable session update, SQL Live/Sandbox/mixed/unknown isolation.');
console.log('Evidence:',root);
