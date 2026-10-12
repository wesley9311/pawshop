import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { cancelOrderWorkflow, refundPaymentWorkflow } from '@medusajs/core-flows'
import { handleOrderCancelled, handleRefundCompleted, handleRefundReview, retryOnce } from '../src/lib/order-notification-subscriber-helper'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
export default async function ({container}:any) {
 const url=new URL(process.env.DATABASE_URL!)
 if(url.hostname!=='127.0.0.1'||url.port!=='54329'||!url.pathname.startsWith('/pawshop_payment_acceptance_'))throw Error('Scratch DB required')
 const {startSmtpSink}=await import(process.env.PAWSHOP_SMTP_SINK!)
 const sink=await startSmtpSink({key:readFileSync(process.env.PAWSHOP_TEST_TLS_KEY!),cert:readFileSync(process.env.NODE_EXTRA_CA_CERTS!),requireAuth:true})
 const credentials={host:'127.0.0.1',port:sink.port,secure:true,user:'owner@example.test',password:'app-password-1234',from:'owner@example.test'}
 require('../src/lib/email-channel.cjs').readEmailCredentials=()=>credentials
 const logger=container.resolve('logger'), payment=container.resolve(Modules.PAYMENT), orders=container.resolve(Modules.ORDER), notification=container.resolve('pawshopNotification')
 const records:any={};let serial=0
 global.fetch=async(url:any,init:any={})=>{
  const path=new URL(String(url)).pathname;let body:any
  if(path==='/v1/oauth2/token')body={access_token:'controlled',expires_in:3600}
  else if(path==='/v2/checkout/orders'&&init.method==='POST'){
   const request=JSON.parse(init.body),id='ORDER'+(++serial);records[id]={id,session:request.purchase_units[0].custom_id,captured:false,authorization:'CREATED',refunds:{}}
   body={id,status:'CREATED',links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token='+id}]}
  }else if(path.startsWith('/v2/checkout/orders/')){
   const r=records[path.split('/')[4]],refunded=Object.values(r.refunds).reduce((s:number,v:any)=>s+(v.status==='COMPLETED'?Number(v.amount):0),0)
   body={id:r.id,intent:'AUTHORIZE',status:'COMPLETED',purchase_units:[{custom_id:r.session,amount:{value:'25.00',currency_code:'USD'},payments:{authorizations:[{id:'AUTH'+r.id,status:r.authorization}],captures:r.captured?[{id:'CAP'+r.id,status:refunded>=25?'REFUNDED':refunded>0?'PARTIALLY_REFUNDED':'COMPLETED',amount:{value:'25.00',currency_code:'USD'}}]:[]}}]}
  }else if(path.endsWith('/capture')){
   const r=records[path.split('/')[4].replace('AUTH','')];r.captured=true;body={id:'CAP'+r.id,status:'COMPLETED',amount:{value:'25.00',currency_code:'USD'}}
  }else if(path.endsWith('/void')){records[path.split('/')[4].replace('AUTH','')].authorization='VOIDED';return new Response(null,{status:204})}
  else if(path.endsWith('/refund')){
   const r=records[path.split('/')[4].replace('CAP','')],id='REF'+r.id+Object.keys(r.refunds).length,amount=JSON.parse(init.body).amount.value;r.refunds[id]={amount,status:'COMPLETED'};body={id,status:'COMPLETED',amount:{value:amount,currency_code:'USD'}}
  }else if(path.startsWith('/v2/payments/refunds/')){
   const id=path.split('/')[4],r:any=Object.values(records).find((r:any)=>r.refunds[id]);const f=r.refunds[id];body={id,status:f.status,amount:{value:f.amount,currency_code:'USD'},links:[{rel:'up',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP'+r.id}]}
  }else throw Error('Unexpected controlled provider request')
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})
 }
 const region=await container.resolve(Modules.REGION).createRegions({name:'CONTROLLED NOTIFICATION',currency_code:'usd',countries:['us']})
 const create=()=>orders.createOrders({region_id:region.id,currency_code:'usd',email:'customer@example.invalid',items:[{title:'CONTROLLED NOTIFICATION FIXTURE',quantity:1,unit_price:25}],metadata:{controlled_acceptance:true}})
 const plain=(message:string)=>{const match=/Content-Type: text\/plain[^\r\n]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)(?:\r\n--|$)/i.exec(message);assert.ok(match);return Buffer.from(match[1].replace(/\r\n/g,''),'base64').toString('utf8')}
 try{
  const unpaid=await create();await cancelOrderWorkflow(container).run({input:{order_id:unpaid.id}})
  assert.equal(await handleOrderCancelled(container,logger,unpaid.id),'sent');assert.match(plain(sink.messages.at(-1).body),/No completed payment capture/)
  assert.match(plain(sink.messages.at(-1).body),/No payment authorization/)
  const count=sink.messages.length;await Promise.all([handleOrderCancelled(container,logger,unpaid.id),handleOrderCancelled(container,logger,unpaid.id)]);assert.equal(sink.messages.length,count)
  const paid=await create(),pc=await payment.createPaymentCollections({amount:25,currency_code:'usd'})
  await container.resolve(ContainerRegistrationKeys.LINK).create({[Modules.ORDER]:{order_id:paid.id},[Modules.PAYMENT]:{payment_collection_id:pc.id}})
  const session=await payment.createPaymentSession(pc.id,{provider_id:'pp_paypal_paypal',amount:25,currency_code:'usd',data:{},context:{}})
  const captured=await payment.authorizePaymentSession(session.id,{})
  await refundPaymentWorkflow(container).run({input:{payment_id:captured.id,amount:5}})
  const refunded=await payment.retrievePayment(captured.id,{relations:['refunds']});const refund=refunded.refunds[0]
  sink.rejectNextRecipient();assert.equal(await handleRefundCompleted(container,logger,refund.id),'error');const beforeRetry=sink.messages.length
  // Clock travel affects only this isolated notification state machine.
  const realClaim=notification.tryClaim.bind(notification);notification.tryClaim=(input:any)=>realClaim({...input,now:new Date(Date.now()+180000)})
  assert.equal(await retryOnce(container,logger,'refund_completed',refund.id),'sent');assert.equal(sink.messages.length,beforeRetry+1)
  const text=plain(sink.messages.at(-1).body);assert.match(text,/refund has been confirmed/);assert.match(text,/USD 5\.00/);assert.match(text,/Order number:/)
  await handleRefundCompleted(container,logger,refund.id);assert.equal(sink.messages.length,beforeRetry+1)
  const provisional=await payment.createRefunds({payment:captured.id,amount:2,note:'CONTROLLED unconfirmed refund'})
  const beforeProvisional=sink.messages.length
  assert.equal(await handleRefundCompleted(container,logger,provisional.id),'unverified');assert.equal(sink.messages.length,beforeProvisional)
  await payment.deleteRefunds(provisional.id)
  assert.equal(await retryOnce(container,logger,'refund_completed',provisional.id),'suppressed')
  const key='refund:'+refund.id+':completed';const row=(await notification.listTransactionalEmailSents({idempotency_key:key}))[0];assert.equal(row.status,'sent');assert.equal(row.attempt_count,2)
  const ledger=container.resolve('pawshopPaymentReconciliation');const record=records[session.data.id];record.refunds.PENDING={amount:'5.00',status:'PENDING'}
  const review=await ledger.createPaymentReconciliations({provider_event_id:'CONTROLLED-REVIEW',external_id:'PENDING',event_type:'refund',capture_id:'CAP'+record.id,payment_id:captured.id,order_id:paid.id,amount:'5.00',currency_code:'USD',status:'review'})
  await handleRefundReview(container,logger,review.id);assert.match(plain(sink.messages.at(-1).body),/still being processed/)
  record.refunds.PENDING.status='FAILED';await handleRefundReview(container,logger,review.id);assert.match(plain(sink.messages.at(-1).body),/reviewing the refund/)
  const reviewCount=sink.messages.length;await handleRefundReview(container,logger,review.id);assert.equal(sink.messages.length,reviewCount)
  await ledger.updatePaymentReconciliations({id:review.id,status:'applied'})
  // Captured cancellation performs the official remaining refund first.
  await cancelOrderWorkflow(container).run({input:{order_id:paid.id}});await handleOrderCancelled(container,logger,paid.id)
  const cancelledText=plain(sink.messages.at(-1).body);assert.match(cancelledText,/Payment captured: USD 25\.00/);assert.match(cancelledText,/Refund confirmed: USD 25\.00/)
  const authorized=await create(),apc=await payment.createPaymentCollections({amount:25,currency_code:'usd'})
  await container.resolve(ContainerRegistrationKeys.LINK).create({[Modules.ORDER]:{order_id:authorized.id},[Modules.PAYMENT]:{payment_collection_id:apc.id}})
  const as=await payment.createPaymentSession(apc.id,{provider_id:'pp_paypal_paypal',amount:25,currency_code:'usd',data:{},context:{}})
  await payment.createPayments({amount:25,currency_code:'usd',provider_id:as.provider_id,payment_session:as.id,payment_collection_id:apc.id,data:{...as.data,authorization_id:'AUTH'+as.data.id}})
  await payment.updatePaymentSessions({id:as.id,status:'authorized',authorized_at:new Date()})
  await cancelOrderWorkflow(container).run({input:{order_id:authorized.id}});await handleOrderCancelled(container,logger,authorized.id);assert.match(plain(sink.messages.at(-1).body),/authorization has been voided/)
  const pendingOrder=await create(),pendingCollection=await payment.createPaymentCollections({amount:25,currency_code:'usd'})
  await container.resolve(ContainerRegistrationKeys.LINK).create({[Modules.ORDER]:{order_id:pendingOrder.id},[Modules.PAYMENT]:{payment_collection_id:pendingCollection.id}})
  await payment.createPaymentSession(pendingCollection.id,{provider_id:'pp_paypal_paypal',amount:25,currency_code:'usd',data:{},context:{}})
  await cancelOrderWorkflow(container).run({input:{order_id:pendingOrder.id}});await handleOrderCancelled(container,logger,pendingOrder.id)
  assert.match(plain(sink.messages.at(-1).body),/Payment status needs review/);assert.doesNotMatch(plain(sink.messages.at(-1).body),/No payment authorization is recorded/)
  const ambiguous=await create();await cancelOrderWorkflow(container).run({input:{order_id:ambiguous.id}});sink.loseNextAcknowledgement()
  assert.equal(await handleOrderCancelled(container,logger,ambiguous.id),'delivery_unknown');const accepted=sink.messages.length
  await handleOrderCancelled(container,logger,ambiguous.id);assert.equal(sink.messages.length,accepted)
  const unknown=(await notification.listTransactionalEmailSents({idempotency_key:'order:'+ambiguous.id+':order_cancelled'}))[0];assert.equal(unknown.error_category,'delivery_unknown')
  writeFileSync(process.cwd()+'/financial-notification-proof.json',JSON.stringify({accepted_messages:sink.messages.length,unpaid_cancel:true,authorized_void:true,captured_cancel_refund:true,refund_confirmed:true,processing_review:true,duplicate_suppressed:true,retry_one_effective:true,uncertain_delivery_not_resent:true}),{mode:0o600})
  console.log('FINANCIAL_NOTIFICATION_E2E_PASS: real Medusa/PG + TLS SMTP; trusted facts, duplicate/retry and unknown delivery verified')
 }finally{await sink.close()}
}
