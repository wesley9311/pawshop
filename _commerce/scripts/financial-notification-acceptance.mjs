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
for (const module of ['paypal', 'pawshop-payment-reconciliation', 'pawshop-payment', 'pawshop-notification']) {
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
 { resolve: './src/modules/pawshop-payment-reconciliation' }, {resolve:'./src/modules/pawshop-notification'}
 ]
})`);
const fixture = readFileSync(join(source, 'tests/financial-notification-acceptance.ts'), 'utf8').replaceAll("../src/lib/", "../lib/");
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

const key=join(root,'tls-key.pem'),cert=join(root,'tls-cert.pem');
const tls=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});if(tls.status!==0)throw Error('Test TLS certificate failed');
Object.assign(env,{PAYPAL_SANDBOX:'true',PAYPAL_CLIENT_ID:'controlled',PAYPAL_CLIENT_SECRET:'controlled',NODE_EXTRA_CA_CERTS:cert,PAWSHOP_TEST_TLS_KEY:key,PAWSHOP_SMTP_SINK:join(source,'tests/email-delivery/smtp-sink.mjs')});
for(const [label,args]of [['migrate',['db:migrate']],['acceptance',['exec','./src/scripts/acceptance.ts']]]){const r=spawnSync(join(root,'node_modules/.bin/medusa'),args,{cwd:root,env,encoding:'utf8'});writeFileSync(join(root,label+'.log'),r.stdout+r.stderr,{mode:0o600});if(r.status!==0)throw Error(label+' failed; evidence '+root);}console.log('FINANCIAL NOTIFICATION CONTROLLED E2E PASS; evidence:',root);
