'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const environmentContext = new AsyncLocalStorage();
const BASE = Object.freeze({sandbox:'https://api-m.sandbox.paypal.com',live:'https://api-m.paypal.com'});
function environmentOf(data) {
 const value=data?.paypal_environment;
 if(!Object.hasOwn(BASE,value))throw Error('paypal_environment_missing_or_invalid');
 if(data.approval_url){let u;try{u=new URL(data.approval_url)}catch{throw Error('paypal_environment_conflict')}
  if(u.protocol!=='https:'||u.hostname!==(value==='sandbox'?'www.sandbox.paypal.com':'www.paypal.com'))throw Error('paypal_environment_conflict');}
 return value;
}
function sameEnvironment(...data){const environments=data.map(environmentOf);if(new Set(environments).size!==1)throw Error('paypal_environment_mixed');return environments[0];}
function configuration(env=process.env,legacy={}){
 const active=env.PAYPAL_ACTIVE_ENV||(env.PAYPAL_SANDBOX==='true'||legacy.sandbox===true?'sandbox':null);
 if(!Object.hasOwn(BASE,active))throw Error('paypal_active_environment_required');
 const clients={};
 for(const name of Object.keys(BASE)){const p='PAYPAL_'+name.toUpperCase()+'_';let client_id=env[p+'CLIENT_ID']||'',client_secret=env[p+'CLIENT_SECRET']||'',webhook_id=env[p+'WEBHOOK_ID']||'';
  // Compatibility is Sandbox-only. A legacy mode flag cannot enable Live.
  if(name==='sandbox'&&!client_id&&!client_secret&&!webhook_id&&(env.PAYPAL_SANDBOX==='true'||legacy.sandbox===true)){
   client_id=env.PAYPAL_CLIENT_ID||legacy.client_id||'';client_secret=env.PAYPAL_CLIENT_SECRET||legacy.client_secret||'';webhook_id=env.PAYPAL_WEBHOOK_ID||legacy.webhook_id||'';
  }
  const count=[client_id,client_secret,webhook_id].filter(Boolean).length;if(count&&count!==3)throw Error('paypal_environment_credentials_incomplete');
  if(count)clients[name]={client_id,client_secret,webhook_id,base:BASE[name]};
 }
 if(!clients[active])throw Error('paypal_active_credentials_missing');
 if(clients.sandbox&&clients.live&&['client_id','client_secret','webhook_id'].some(k=>clients.sandbox[k]===clients.live[k]))throw Error('paypal_credentials_not_isolated');
 return {active,clients};
}
function clientFor(environment,config){if(!Object.hasOwn(BASE,environment)||!config.clients[environment])throw Error('paypal_environment_credentials_missing');return config.clients[environment];}
const tokens = new WeakMap();
async function request(environment,method,path,body,headers={},config=configuration()){
 const c=clientFor(environment,config);
 let cached=tokens.get(c);
 if(!cached || cached.expiresAt<Date.now()+60000){
  const a=await fetch(c.base+'/v1/oauth2/token',{method:'POST',signal:AbortSignal.timeout(10000),headers:{authorization:'Basic '+Buffer.from(c.client_id+':'+c.client_secret).toString('base64'),'content-type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
  if(!a.ok)throw Error('paypal_environment_oauth_unavailable');const token=await a.json();if(typeof token.access_token!=='string')throw Error('paypal_environment_oauth_invalid');
  cached={value:token.access_token,expiresAt:Date.now()+Number(token.expires_in||300)*1000};tokens.set(c,cached);
 }
 const r=await fetch(c.base+path,{method,signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+cached.value,'content-type':'application/json',Prefer:'return=representation',...headers},body:body?JSON.stringify(body):undefined});
 if(r.status===401)tokens.delete(c);
 if(!r.ok)throw Error('paypal_environment_request_failed_'+r.status);return r.json();
}
async function verifyDual(headers,raw,config=configuration()){
 const normalized=Object.fromEntries(Object.entries(headers||{}).map(([k,v])=>[k.toLowerCase(),Array.isArray(v)?String(v[0]||''):String(v||'')]));
 const required=['paypal-auth-algo','paypal-cert-url','paypal-transmission-id','paypal-transmission-sig','paypal-transmission-time'];
 if(required.some(k=>!normalized[k])||!raw)return null;
 const event=JSON.parse(Buffer.isBuffer(raw)?raw.toString('utf8'):raw);
 const matches=[];
 for(const environment of Object.keys(config.clients)){
  const c=clientFor(environment,config);const result=await request(environment,'POST','/v1/notifications/verify-webhook-signature',{
   auth_algo:normalized['paypal-auth-algo'],cert_url:normalized['paypal-cert-url'],transmission_id:normalized['paypal-transmission-id'],transmission_sig:normalized['paypal-transmission-sig'],transmission_time:normalized['paypal-transmission-time'],webhook_id:c.webhook_id,webhook_event:event}, {},config);
  if(result.verification_status==='SUCCESS')matches.push(environment);
 }
 return matches.length===1?matches[0]:null;
}
function resourceKey(environment,id){if(!Object.hasOwn(BASE,environment)||typeof id!=='string'||!id)throw Error('paypal_resource_identity_invalid');return environment+':'+id;}
function requestId(environment,operation,id){return createHash('sha256').update(`pawshop:${resourceKey(environment,id)}:${operation}`).digest('hex').slice(0,32);}
module.exports={BASE,environmentOf,sameEnvironment,configuration,clientFor,request,verifyDual,resourceKey,requestId,environmentContext};
