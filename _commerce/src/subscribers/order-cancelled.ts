import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { handleOrderCancelled } from '../lib/order-notification-subscriber-helper'
export default async function ({event,container}:SubscriberArgs<{id:string}>) {
 if(event.data?.id)await handleOrderCancelled(container,container.resolve('logger'),event.data.id)
}
export const config:SubscriberConfig={event:'order.canceled'}
