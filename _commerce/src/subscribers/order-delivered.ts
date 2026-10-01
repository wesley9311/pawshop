import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { handleDeliveryCreated } from '../lib/order-notification-subscriber-helper'

// delivery.created → "Order delivered".
//
// The event payload is thin: `{ id, no_notification }`, where `id` is the
// fulfillment id. The shared helper resolves the order through the
// order_fulfillment link and sends only when `no_notification` is not set. The
// email never invents a carrier state — it says only that the order was
// delivered, which is exactly what this event asserts.
export default async function orderDeliveredHandler({ event, container }: SubscriberArgs<Record<string, unknown>>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as {
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string) => void
  }
  const fulfillmentId = typeof event.data?.id === 'string' && event.data.id ? event.data.id : ''
  if (!fulfillmentId) {
    logger.warn('order email: delivery.created carried no fulfillment id - not sending')
    return
  }
  const noNotification = event.data?.no_notification === true
  await handleDeliveryCreated(container, logger, fulfillmentId, noNotification)
}

export const config: SubscriberConfig = {
  event: 'delivery.created',
}
