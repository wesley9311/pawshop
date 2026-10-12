import type { MedusaContainer } from '@medusajs/framework/types'
import { Modules } from '@medusajs/framework/utils'
// Rollout boundary, not a historical email backfill. Old completed business
// events stay untouched; new cancellations/refunds remain recoverable even if
// their first subscriber delivery was lost before a notification claim existed.
const START_AT = new Date('2026-10-12T00:00:00.000Z')
export default async function (container:MedusaContainer) {
 const bus=container.resolve(Modules.EVENT_BUS)
 const scan=async(service:any,method:string,filter:any,event:string,eligible=(row:any)=>true)=>{
  let skip=0
  for(;;){
   const rows=await service[method](filter,{take:100,skip,order:{id:'ASC'}})
   for(const row of rows)if(eligible(row))await bus.emit({name:event,data:{id:row.id}})
   if(rows.length<100)break
   skip+=rows.length
  }
 }
 await scan(container.resolve(Modules.ORDER),'listOrders',{status:'canceled',canceled_at:{$gte:START_AT}},'order.canceled')
 await scan(container.resolve(Modules.PAYMENT),'listRefunds',{created_at:{$gte:START_AT}},'refund.created')
 await scan(container.resolve('pawshopPaymentReconciliation'),'listPaymentReconciliations',{event_type:'refund',status:'review',created_at:{$gte:START_AT}},'refund.review_required',row=>row.order_id&&row.payment_id&&row.capture_id)
}
export const config={name:'financial-notification-recovery',schedule:{interval:60000,concurrency:'forbid'}}
