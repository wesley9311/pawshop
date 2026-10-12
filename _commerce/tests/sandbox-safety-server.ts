import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Modules } from '@medusajs/framework/utils'
import { processPaymentWorkflow } from '@medusajs/core-flows'
import Provider from '../src/modules/paypal/service'
import { reconcilePayPalExternalPayment } from '../src/lib/paypal-reconciliation'
import { requireCapturedPayment } from '../src/lib/fulfillment-payment-gate.cjs'
import { serializeAdminRefund } from '../src/lib/order-payment-lock.cjs'
const express = require('express')
// Loopback-only acceptance adapter; official handlers and PawShop middleware.
export default async function ({ container }: any) {
 const db=new URL(process.env.DATABASE_URL||'')
 if(process.env.PAYPAL_SANDBOX!=='true'||db.hostname!=='127.0.0.1'||!/^\/pawshop_payment_sandbox_[a-z0-9_]+$/.test(db.pathname))throw Error('Isolated Sandbox required')
 const root=process.cwd(), evidence=join(root,'webhook-evidence');mkdirSync(evidence,{recursive:true,mode:0o700})
 const token=randomBytes(32).toString('hex');writeFileSync(join(root,'http-test-token'),token,{mode:0o600})
 const provider=new Provider({logger:container.resolve('logger')},{client_id:process.env.PAYPAL_CLIENT_ID!,client_secret:process.env.PAYPAL_CLIENT_SECRET!,sandbox:true,webhook_id:process.env.PAYPAL_WEBHOOK_ID!,return_url:process.env.PAYPAL_RETURN_URL!,cancel_url:process.env.PAYPAL_CANCEL_URL!})
 const originalFetch=global.fetch
 global.fetch=async(url:any,init:any={})=>{
  const response=await originalFetch(url,init)
  const path=new URL(String(url)).pathname
  if(init.method==='POST'&&/^\/v2\/payments\/captures\/[^/]+\/refund$/.test(path))appendFileSync(join(root,'candidate-refund-requests.jsonl'),JSON.stringify({path,method:'POST',status:response.status,at:new Date().toISOString()})+'\n',{mode:0o600})
  let race:any;try{race=JSON.parse(readFileSync(join(root,'race-state.json'),'utf8'))}catch{return response}
  if(path==='/v2/checkout/orders/'+race.provider_order_id+'/authorize'&&response.ok){
   const body:any=await response.clone().json();race.authorization_id=body.purchase_units?.[0]?.payments?.authorizations?.[0]?.id
   writeFileSync(join(root,'race-state.json'),JSON.stringify(race),{mode:0o600})
  }
  if(path==='/v2/payments/authorizations/'+race.authorization_id+'/capture'){
   const body:any=await response.clone().json()
   appendFileSync(join(root,'capture-request-evidence.jsonl'),JSON.stringify({path,request_id:init.headers?.['PayPal-Request-Id'],status:response.status,capture_id:body.id,capture_status:body.status})+'\n',{mode:0o600})
   if(response.ok&&body.status==='COMPLETED'&&race.inject_capture_response_loss&&!race.response_loss_injected){
    race=JSON.parse(readFileSync(join(root,'race-state.json'),'utf8'));race.response_loss_injected=true;race.capture_id=body.id
    writeFileSync(join(root,'race-state.json'),JSON.stringify(race),{mode:0o600});throw Error('Injected lost response after real Sandbox capture')
   }
  }
  return response
 }
 const traceFailure=(phase:string,error:any)=>appendFileSync(join(root,'payment-failures.jsonl'),JSON.stringify({phase,type:typeof error?.type==='string'?error.type:'unknown',category:/already exists/.test(String(error?.message))?'duplicate_payment':/lock/.test(String(error?.message))?'lock_unavailable':/timeout|response lost/.test(String(error?.message))?'network_or_injected_timeout':'unclassified',at:new Date().toISOString()})+'\n',{mode:0o600})
 const app=express();app.get('/health',(_req:any,res:any)=>res.json({sandbox:true,isolated:true}))
 app.post('/webhook',express.raw({type:'application/json',limit:'1mb'}),async(req:any,res:any)=>{
  try{
   const raw=req.body,body=JSON.parse(raw.toString('utf8'));if(typeof body.id!=='string'||!/^[A-Za-z0-9_-]+$/.test(body.id))return res.sendStatus(400)
   req.rawBody=raw;req.body=body;req.scope=container
   writeFileSync(join(evidence,body.id+'-'+Date.now()+'.json'),JSON.stringify({received_at:new Date().toISOString(),headers:req.headers,raw:raw.toString('utf8')}),{mode:0o600})
   res.once('finish',()=>appendFileSync(join(evidence,'results.jsonl'),JSON.stringify({id:body.id,type:body.event_type,http:res.statusCode,at:new Date().toISOString()})+'\n',{mode:0o600}))
   let race:any;try{race=JSON.parse(readFileSync(join(root,'race-state.json'),'utf8'))}catch{}
   if(race?.hold_webhooks&&['CHECKOUT.ORDER.APPROVED','PAYMENT.CAPTURE.COMPLETED'].includes(body.event_type)&&
      (body.resource?.id===race.provider_order_id||body.resource?.custom_id===race.session_id||body.resource?.supplementary_data?.related_ids?.order_id===race.provider_order_id)){
    const action=await provider.getWebhookActionAndData({data:body,headers:req.headers,rawData:raw}as any)
    if(action.action==='not_supported')return res.sendStatus(400)
    appendFileSync(join(evidence,'held.jsonl'),JSON.stringify({id:body.id,type:body.event_type,session_id:action.data?.session_id})+'\n',{mode:0o600})
    return res.sendStatus(200)
   }
   await reconcilePayPalExternalPayment(req,res,async()=>{
    try{
     const action=await provider.getWebhookActionAndData({data:body,headers:req.headers,rawData:raw}as any)
     if(action.action==='not_supported'||!action.data?.session_id)return res.sendStatus(200)
     const sessions=await container.resolve(Modules.PAYMENT).listPaymentSessions({id:action.data.session_id})
     if(sessions.length!==1)return res.sendStatus(200)
     await processPaymentWorkflow(container).run({input:action});res.sendStatus(200)
    }catch(error){traceFailure('webhook',error);res.sendStatus(503)}
   })
  }catch(_){if(!res.headersSent)res.sendStatus(503)}
 })
 app.use(express.json());app.use((req:any,res:any,next:any)=>{
  if(req.headers.authorization!=='Bearer '+token)return res.sendStatus(401)
  req.scope=container;req.auth_context={actor_id:'isolated-sandbox-admin',actor_type:'user'};req.validatedBody=req.body;req.queryConfig={fields:['id','fulfillments.*','items.*']};next()
 })
 const route=(path:string)=>require(join(root,'node_modules/@medusajs/medusa/dist/api/admin',path,'route.js')).POST
 const wrap=(fn:any)=>(req:any,res:any,next:any)=>Promise.resolve(fn(req,res,next)).catch(next)
 app.post('/admin/orders/:id/fulfillments',wrap(requireCapturedPayment),wrap(route('orders/[id]/fulfillments')))
 app.post('/admin/orders/:id/fulfillments/:fulfillment_id/shipments',wrap(requireCapturedPayment),wrap(route('orders/[id]/fulfillments/[fulfillment_id]/shipments')))
 app.post('/admin/orders/:id/fulfillments/:fulfillment_id/mark-as-delivered',wrap(requireCapturedPayment),wrap(route('orders/[id]/fulfillments/[fulfillment_id]/mark-as-delivered')))
 app.post('/admin/payments/:id/refund',wrap(serializeAdminRefund),wrap(route('payments/[id]/refund')))
 app.post('/callback',async(req:any,res:any)=>{try{const payment=await container.resolve(Modules.PAYMENT).authorizePaymentSession(req.body.session_id,{});res.json({payment_id:payment?.id,captured_at:payment?.captured_at})}catch(error){traceFailure('callback',error);res.sendStatus(503)}})
 app.use((error:any,_req:any,res:any,_next:any)=>{appendFileSync(join(root,'http-errors.jsonl'),JSON.stringify({type:error.type,message:error.message,at:new Date().toISOString()})+'\n',{mode:0o600});res.status(500).json({error:'isolated_acceptance_route_failed'})})
 await new Promise<void>((resolve)=>{const server=app.listen(9005,'127.0.0.1',()=>console.log('ISOLATED_SANDBOX_HTTP_READY'));process.once('SIGTERM',()=>server.close(()=>resolve()))})
}
