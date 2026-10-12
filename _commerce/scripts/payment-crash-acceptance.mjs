// Controlled fixtures only, in a newly created loopback database. No production
// configuration, PayPal credentials, network funds, or existing database writes.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawnSync, spawn } from 'node:child_process';
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
symlinkSync(join(source,'src/jobs'),join(root,'src/jobs'));
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
const fixture = readFileSync(join(source, 'tests/payment-crash-worker.ts'), 'utf8').replaceAll("from '../src/lib/", "from '../lib/").replaceAll("from '../src/jobs/", "from '../jobs/").replaceAll("from '../src/modules/", "from '../modules/");
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

const {createServer}=await import('node:http');
const records=new Map();let next=0;let loseNextCaptureResponse=false;let failNextRead=false;
const server=createServer(async(req,res)=>{
 let text='';for await(const chunk of req)text+=chunk;const path=req.url;let body;if(failNextRead&&req.method==='GET'){failNextRead=false;res.statusCode=503;res.end('{}');return;}
 if(path==='/v1/oauth2/token')body={access_token:'mock',expires_in:3600};
 else if(path==='/v2/checkout/orders'&&req.method==='POST'){const sid=JSON.parse(text).purchase_units[0].custom_id;const id='ORDER-'+(++next);records.set(id,{id,sid,captures:0,keys:[],captured:false});body={id,status:'CREATED',links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token='+id}]};}
 else if(path.startsWith('/v2/checkout/orders/')){const id=path.split('/')[4];const r=records.get(id);body={id,status:'COMPLETED',intent:'AUTHORIZE',purchase_units:[{custom_id:r.sid,amount:{value:'25.00',currency_code:'USD'},payments:{authorizations:[{id:'AUTH-'+id,status:'CREATED'}],captures:r.captured?[{id:'CAP-'+id,status:'COMPLETED',amount:{value:'25.00',currency_code:'USD'}}]:[]}}]};}
 else if(path.endsWith('/capture')){const id=path.split('/')[4].replace('AUTH-','');const r=records.get(id);r.keys.push(req.headers['paypal-request-id']);if(!r.captured){r.captured=true;r.captures++;}if(loseNextCaptureResponse){loseNextCaptureResponse=false;res.destroy();return;}body={id:'CAP-'+id,status:'COMPLETED',amount:{value:'25.00',currency_code:'USD'}};}
 else {res.statusCode=400;body={error:'unexpected mock request',path};}
 res.setHeader('content-type','application/json');res.end(JSON.stringify(body));
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));env.MOCK_PAYPAL_URL='http://127.0.0.1:'+server.address().port;
const migrate=spawnSync(join(root,'node_modules/.bin/medusa'),['db:migrate'],{cwd:root,env,encoding:'utf8'});writeFileSync(join(root,'migrate.log'),migrate.stdout+migrate.stderr);if(migrate.status!==0)throw Error('migrate failed '+root);
const children=new Set();
const run=(phase,stop=false)=>new Promise((resolve,reject)=>{
 const child=spawn(join(root,'node_modules/.bin/medusa'),['exec','./src/scripts/acceptance.ts'],{cwd:root,env:{...env,CRASH_PHASE:phase},detached:true});children.add(child.pid);let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const timeout=setTimeout(()=>{process.kill(-child.pid,'SIGKILL');reject(Error('worker timeout '+phase+' '+root))},phase==='recovery-timer'?90000:45000);
 let poll;if(stop)poll=setInterval(()=>{try{readFileSync(join(root,'crash-marker'));clearInterval(poll);if(phase==='D'){const saved=readFileSync(join(root,'crash-state.json'));run('seed').then(()=>run('E')).then(()=>{writeFileSync(join(root,'crash-state.json'),saved);process.kill(-child.pid,'SIGKILL')}).catch(reject)}else process.kill(-child.pid,'SIGKILL')}catch{}},50);
 child.on('exit',(code,signal)=>{children.delete(child.pid);clearTimeout(timeout);clearInterval(poll);writeFileSync(join(root,phase+'-'+Date.now()+'.log'),output,{mode:0o600});if(stop&&signal==='SIGKILL'||code===0)resolve({code,signal});else reject(Error('worker failed '+phase+' '+root));});
});
const {unlinkSync}=await import('node:fs');const matrix=[];
try{for(const phase of (process.argv.includes('--timer-only')?['H']:['A','B','C','D','E','F','G'])){
 await run('seed');try{unlinkSync(join(root,'crash-marker'))}catch{}
 if(phase==='H'){}else if(phase==='G')await run('G');else if(phase==='F'){loseNextCaptureResponse=true;await assert.rejects(run('F'));}else if(phase==='E')await Promise.all([run('E'),run('E')]);else await run(phase,true);
 await run('before');const before=JSON.parse(readFileSync(join(root,'before-gate.json')));
 if(['A','B','D','F','G'].includes(phase))assert.equal(before.allowed,false);
 failNextRead=['A','B','D','F','G'].includes(phase);await run(phase==='H'?'recovery-timer':'recovery');failNextRead=false;const result=JSON.parse(readFileSync(join(root,'convergence-result.json')));const state=JSON.parse(readFileSync(join(root,'crash-state.json')));const provider=[...records.values()].find(r=>r.sid===state.session);
 assert.equal(provider.captures,1);assert.equal(new Set(provider.keys).size,1);matrix.push({phase,before,...result,provider_captures:provider.captures});console.log('CRASH CASE VERIFIED',phase);
}writeFileSync(join(root,'crash-matrix.json'),JSON.stringify(matrix,null,2));console.log('CRASH MATRIX PASS',JSON.stringify(matrix));console.log('Evidence:',root);}
finally{for(const pid of children){try{process.kill(-pid,'SIGKILL')}catch{}}server.close()}
