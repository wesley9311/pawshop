import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { Modules } from '@medusajs/framework/utils'
import { handleRefundCompleted, handleRefundReview } from '../lib/order-notification-subscriber-helper'
export default async function ({event,container}:SubscriberArgs<{id:string}>) {
 if(!event.data?.id)return
 const logger=container.resolve('logger')
 try {
  if(event.name==='refund.review_required')return await handleRefundReview(container,logger,event.data.id)
  if(event.name==='refund.created')return await handleRefundCompleted(container,logger,event.data.id)
  const payment=await container.resolve(Modules.PAYMENT).retrievePayment(event.data.id,{relations:['refunds']})
  for(const refund of payment.refunds||[])await handleRefundCompleted(container,logger,refund.id)
 }catch{logger.warn('order email: refund source unavailable; no success notification sent')}
}
export const config:SubscriberConfig={event:['payment.refunded','refund.created','refund.review_required']}
