import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import Provider from '../src/modules/paypal/service'
import { JobLoader } from '@medusajs/framework/jobs'
import convergenceJob, { config as convergenceConfig } from '../src/jobs/payment-convergence'
import { withPaymentSessionLock } from '../src/lib/payment-session-lock'
import { requireCapturedPayment } from '../src/lib/fulfillment-payment-gate.cjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
export default async function ({container}:any) {
 if(!/^\/pawshop_payment_acceptance_/.test(new URL(process.env.DATABASE_URL!).pathname))throw Error('Scratch DB only')
 const phase=process.env.CRASH_PHASE!,stateFile=process.cwd()+'/crash-state.json'
 const original=global.fetch
 const stop=async()=>{writeFileSync(process.cwd()+'/crash-marker',phase);await new Promise(()=>{})}
 global.fetch=async(url:any,init:any={})=>{
  const path=new URL(String(url)).pathname
  if(phase==='A'&&path.endsWith('/capture'))await stop()
  const response=await original(process.env.MOCK_PAYPAL_URL+path,init)
  if(phase==='B'&&path.endsWith('/capture')&&response.ok)await stop()
  return response
 }
 const payment=container.resolve(Modules.PAYMENT)
 if(phase==='seed'){
  const order=await container.resolve(Modules.ORDER).createOrders({currency_code:'usd',items:[{title:'CONTROLLED CRASH FIXTURE',quantity:1,unit_price:25}],metadata:{controlled_acceptance:true}})
  const pc=await payment.createPaymentCollections({amount:25,currency_code:'usd'})
  await container.resolve(ContainerRegistrationKeys.LINK).create({[Modules.ORDER]:{order_id:order.id},[Modules.PAYMENT]:{payment_collection_id:pc.id}})
  const session=await payment.createPaymentSession(pc.id,{provider_id:'pp_paypal_paypal',amount:25,currency_code:'usd',data:{},context:{}})
  writeFileSync(stateFile,JSON.stringify({session:session.id,order:order.id,collection:pc.id}))
  return
 }
 const state=JSON.parse(readFileSync(stateFile,'utf8'))
 if(phase==='G'){
  const session=await payment.retrievePaymentSession(state.session)
  const provider=new Provider({logger:container.resolve('logger')},{client_id:'controlled',client_secret:'controlled',sandbox:true,webhook_id:'controlled',return_url:'https://pawlivora.com',cancel_url:'https://pawlivora.com'})
  const external=await provider.authorizePayment({data:session.data,context:{idempotency_key:session.id}})
  // Isolated fault fixture: committed authorization but missing local capture.
  // These official service writes prepare the fault; recovery performs no SQL repair.
  await payment.createPayments({amount:25,currency_code:'usd',provider_id:session.provider_id,payment_session:session.id,payment_collection_id:state.collection,data:external.data})
  await payment.updatePaymentSessions({id:session.id,status:'authorized',authorized_at:new Date(),data:external.data})
  return
 }
 if(phase==='D'){await withPaymentSessionLock(state.session,stop);return}
 if(['A','B','C','E','F'].includes(phase)){
  await payment.authorizePaymentSession(state.session,{})
  if(phase==='C')await stop()
  return
 }
 const gate=async()=>{
  const res:any=new EventEmitter();let allowed=false,code=0
  res.status=(v:number)=>{code=v;return res};res.json=()=>{res.emit('finish');return res}
  await requireCapturedPayment({scope:container,originalUrl:'/admin/orders/'+state.order+'/fulfillments',params:{id:state.order},body:{}},res,()=>{allowed=true;res.emit('finish')})
  return{allowed,code}
 }
 if(phase==='before'){writeFileSync(process.cwd()+'/before-gate.json',JSON.stringify(await gate()));return}
 if(['recovery','recovery-timer'].includes(phase)){
  // Register and execute through the installed Medusa job workflow adapter.
  // This verifies the real handler signature; no browser callback or DB repair.
  const loader:any=new JobLoader([],container)
  await loader.onFileLoaded('isolated-payment-convergence', {default:convergenceJob,config:convergenceConfig})
  const engine=container.resolve(Modules.WORKFLOW_ENGINE)
  const storage=engine.workflowOrchestratorService_.inMemoryDistributedTransactionStorage_
  if(phase==='recovery-timer')await storage.schedule('job-pawshop-payment-convergence',convergenceConfig.schedule)
  for(let attempt=0;attempt<(phase==='recovery-timer'?16:3);attempt++){
   if(phase==='recovery-timer')await new Promise(resolve=>setTimeout(resolve,5000))
   else await engine.run('job-pawshop-payment-convergence',{input:{}})
   const facts=await payment.listPayments({payment_session_id:state.session},{relations:['captures']})
   if(facts.length===1&&facts[0].captured_at&&facts[0].captures.length===1){
    const pc=await payment.retrievePaymentCollection(state.collection)
    assert.equal(Number(pc.captured_amount),25)
    const verdict=await gate();assert.equal(verdict.allowed,true)
    if(phase==='recovery-timer')await storage.remove('job-pawshop-payment-convergence')
    writeFileSync(process.cwd()+'/convergence-result.json',JSON.stringify({payments:facts.length,captures:facts[0].captures.length,captured_amount:Number(pc.captured_amount),gate:verdict}));return
   }
  }
  throw Error('Did not automatically converge')
 }
}
