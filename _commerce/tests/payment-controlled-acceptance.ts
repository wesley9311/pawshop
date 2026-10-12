import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { refundPaymentWorkflow, capturePaymentWorkflow } from '@medusajs/core-flows'
import { externalRefundContext } from '../src/lib/paypal-external-refund-context'
import { paymentGateDecision, requireCapturedPayment } from '../src/lib/fulfillment-payment-gate.cjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
export default async function({container}: any) {
 const database = new URL(process.env.DATABASE_URL || '')
 if (database.hostname !== '127.0.0.1' || database.port !== '54329' ||
     !/^\/pawshop_payment_acceptance_[a-z0-9_]+$/.test(database.pathname)) throw new Error('Isolated database required')
 const suffix = randomUUID().replaceAll('-', '')
 const calls: string[] = []; let sessionId = ''; let captured = false; let captureStatus = 'COMPLETED'
 global.fetch = async (url: any, init: any = {}) => {
  const path = new URL(String(url)).pathname.replaceAll('-' + suffix, ''); calls.push(init.method + ' ' + path)
  let body: any
  if (path === '/v1/oauth2/token') body = { access_token: 'controlled-token', expires_in: 3600 }
  else if (path === '/v2/checkout/orders' && init.method === 'POST') {
   sessionId = JSON.parse(init.body).purchase_units[0].custom_id
   body = {id: 'CONTROLLED-ORDER', status: 'CREATED', links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token=CONTROLLED'}]}
  } else if (path === '/v2/checkout/orders/CONTROLLED-ORDER') { body = {
   id:'CONTROLLED-ORDER', status:'COMPLETED',intent:'AUTHORIZE',purchase_units:[{custom_id:sessionId,amount:{value:'25.00',currency_code:'USD'},payments:{authorizations:[{id:'CONTROLLED-AUTH'}],captures:captured?[{id:'CONTROLLED-CAP',status:'COMPLETED',amount:{value:'25.00',currency_code:'USD'}}]:[]}}]
  }; } else if (path === '/v2/payments/authorizations/CONTROLLED-AUTH/capture') {
   captured = captureStatus === 'COMPLETED'; body = {id:'CONTROLLED-CAP',status:captureStatus,amount:{value:'25.00',currency_code:'USD'}}
  } else if (path === '/v2/payments/refunds/CONTROLLED-REFUND') body = {id:'CONTROLLED-REFUND',status:'COMPLETED',amount:{value:'5.00',currency_code:'USD'}}
  else throw new Error('Unexpected controlled provider request: '+path)
  return new Response(JSON.stringify(body).replace(/CONTROLLED-(?:ORDER|AUTH|CAP|REFUND)/g, (id) => id + '-' + suffix),{status:200,headers:{'content-type':'application/json'}})
 }
 const regionModule=container.resolve(Modules.REGION)
 const regions=await regionModule.listRegions({name:'CONTROLLED ACCEPTANCE'})
 const region=regions[0] || await regionModule.createRegions({name:'CONTROLLED ACCEPTANCE',currency_code:'usd',countries:['us']})
 const orders=container.resolve(Modules.ORDER)
 const order=await orders.createOrders({currency_code:'usd',region_id:region.id,email:'controlled@example.invalid',items:[{title:'CONTROLLED FIXTURE',quantity:1,unit_price:25}],metadata:{controlled_acceptance:true}})
 const paymentModule=container.resolve(Modules.PAYMENT)
 const pc=await paymentModule.createPaymentCollections({amount:25,currency_code:'usd'})
 await container.resolve(ContainerRegistrationKeys.LINK).create({[Modules.ORDER]:{order_id:order.id},[Modules.PAYMENT]:{payment_collection_id:pc.id}})
 const fulfillment=await container.resolve(Modules.FULFILLMENT).createFulfillment({provider_id:'manual_manual',location_id:'controlled-location',requires_shipping:false,items:[]})
 await container.resolve(ContainerRegistrationKeys.LINK).create({[Modules.ORDER]:{order_id:order.id},[Modules.FULFILLMENT]:{fulfillment_id:fulfillment.id}})
 const assertRoutes = async (allowed: boolean) => {
  for (const route of [
   {path:'/admin/orders/'+order.id+'/fulfillments',params:{id:order.id}},
   {path:'/admin/orders/'+order.id+'/fulfillments/'+fulfillment.id+'/shipments',params:{id:order.id,fulfillment_id:fulfillment.id}},
   {path:'/admin/orders/'+order.id+'/fulfillments/'+fulfillment.id+'/mark-as-delivered',params:{id:order.id,fulfillment_id:fulfillment.id}},
   {path:'/admin/fulfillments',params:{},body:{order_id:order.id}},
   {path:'/admin/fulfillments/'+fulfillment.id+'/shipment',params:{id:fulfillment.id},body:{order_id:'spoofed-order'}},
  ]) {
   const res:any=new EventEmitter();let accepted=false;let code=200
   res.status=(value:number)=>{code=value;return res};res.json=()=>{res.emit('finish');return res}
   await requireCapturedPayment({scope:container,originalUrl:route.path,params:route.params,body:route.body},res,()=>{accepted=true;res.emit('finish')})
   await new Promise((resolve)=>setImmediate(resolve))
   assert.equal(accepted,allowed,route.path+' status='+code)
   if (!allowed) assert.equal(code,409)
  }
 }
 await assertRoutes(false)
 const session=await paymentModule.createPaymentSession(pc.id,{provider_id:'pp_paypal_paypal',amount:25,currency_code:'usd',data:{},context:{}})
 const race=await Promise.allSettled([paymentModule.authorizePaymentSession(session.id,{}),paymentModule.authorizePaymentSession(session.id,{}),paymentModule.authorizePaymentSession(session.id,{})]);console.log('RACE_DIAGNOSTIC',JSON.stringify(race.map((r:any)=>r.status==='rejected'?{error:r.reason?.message,type:r.reason?.type,code:r.reason?.code}:{status:r.status})));const payment=await paymentModule.authorizePaymentSession(session.id,{})
 assert.ok(payment.captured_at)
 const facts=await paymentModule.retrievePayment(payment.id,{relations:['captures','refunds']})
 assert.equal(facts.captures.length,1)
 assert.equal(Number(facts.captures[0].amount),25)
 await capturePaymentWorkflow(container).run({input:{payment_id:payment.id}})
 const query=container.resolve(ContainerRegistrationKeys.QUERY)
 let graph=await query.graph({entity:'order',fields:['id','total','raw_total','currency_code','payment_collections.*','payment_collections.payments.*','payment_collections.payments.captures.*','payment_collections.payments.refunds.*'],filters:{id:order.id}})
 assert.equal(paymentGateDecision(graph.data[0]).allowed,true)
 await assertRoutes(true)
 const ledger=container.resolve('pawshopPaymentReconciliation')
 const review=await ledger.createPaymentReconciliations({provider_event_id:'controlled-review-'+suffix,external_id:'controlled-review-'+suffix,event_type:'reversal',order_id:order.id,status:'review',reason:'controlled_reversal'})
 await assertRoutes(false)
 await ledger.deletePaymentReconciliations(review.id)
 await assertRoutes(true)
 await externalRefundContext.run({refundId:'CONTROLLED-REFUND-'+suffix,captureId:'CONTROLLED-CAP-'+suffix,amount:'5.00',currency:'USD'},()=>refundPaymentWorkflow(container).run({input:{payment_id:payment.id,amount:5,note:'Controlled external refund adoption',metadata:{paypal_refund_id:'CONTROLLED-REFUND-'+suffix}}}))
 const refunded=await paymentModule.retrievePayment(payment.id,{relations:['captures','refunds']})
 assert.equal(refunded.refunds.length,1)
 assert.equal(Number(refunded.refunds[0].amount),5)
 const updatedPc=await paymentModule.retrievePaymentCollection(pc.id)
 assert.equal(Number(updatedPc.refunded_amount),5)
 const transactions=await orders.listOrderTransactions({order_id:order.id})
 assert.ok(transactions.some((row:any)=>row.reference_id===refunded.refunds[0].id&&Number(row.amount)===-5))
 graph=await query.graph({entity:'order',fields:['id','total','currency_code','payment_collections.*','payment_collections.payments.*','payment_collections.payments.captures.*','payment_collections.payments.refunds.*'],filters:{id:order.id}})
 assert.equal(paymentGateDecision(graph.data[0]).allowed,false)
 await assertRoutes(false)
 assert.equal(calls.filter((p)=>p.endsWith('/capture')).length,1)
 assert.equal(calls.filter((p)=>p.includes('/refund')&&p.startsWith('POST')).length,0)

 for (const failureStatus of ['PENDING','DENIED']) {
  captureStatus=failureStatus;captured=false;
  const failedOrder=await orders.createOrders({currency_code:'usd',region_id:region.id,email:'controlled@example.invalid',items:[{title:'CONTROLLED '+failureStatus,quantity:1,unit_price:25}],metadata:{controlled_acceptance:true}});
  const failedPc=await paymentModule.createPaymentCollections({amount:25,currency_code:'usd'});
  await container.resolve(ContainerRegistrationKeys.LINK).create({[Modules.ORDER]:{order_id:failedOrder.id},[Modules.PAYMENT]:{payment_collection_id:failedPc.id}});
  const failedSession=await paymentModule.createPaymentSession(failedPc.id,{provider_id:'pp_paypal_paypal',amount:25,currency_code:'usd',data:{},context:{}});
  try { await paymentModule.authorizePaymentSession(failedSession.id,{}) } catch {}
  const failedPayments=await paymentModule.listPayments({payment_session_id:failedSession.id},{relations:['captures']});
  assert.ok(failedPayments.every((p:any)=>!p.captured_at&&p.captures.length===0));
  const failedFulfillment=await container.resolve(Modules.FULFILLMENT).createFulfillment({provider_id:'manual_manual',location_id:'controlled-location',requires_shipping:false,items:[]});
  await container.resolve(ContainerRegistrationKeys.LINK).create({[Modules.ORDER]:{order_id:failedOrder.id},[Modules.FULFILLMENT]:{fulfillment_id:failedFulfillment.id}});
  for(const tail of ['/fulfillments','/fulfillments/'+failedFulfillment.id+'/shipments','/fulfillments/'+failedFulfillment.id+'/mark-as-delivered']) {
   const res:any=new EventEmitter();let code=0;res.status=(v:number)=>{code=v;return res};res.json=()=>{res.emit('finish');return res};
   await requireCapturedPayment({scope:container,originalUrl:'/admin/orders/'+failedOrder.id+tail,params:{id:failedOrder.id,fulfillment_id:failedFulfillment.id},body:{}},res,()=>{throw Error('Unconfirmed payment allowed')});
   assert.equal(code,409);await new Promise(resolve=>setImmediate(resolve));
  }
 }
 console.log('CONTROLLED_PENDING_DENIED_VERIFIED: official authorization creates no trusted capture; create/ship/deliver gates reject');
 console.log('CONTROLLED_DB_VERIFIED: capture fact + gate + external refund adoption + PC aggregate + order transaction; no second provider refund')
}
