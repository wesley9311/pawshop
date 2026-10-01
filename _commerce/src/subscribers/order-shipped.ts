import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { handleShipmentCreated } from '../lib/order-notification-subscriber-helper'

// shipment.created → "Order shipped".
//
// The event payload is thin: `{ id, no_notification }`, where `id` is the
// fulfillment id. The shared helper resolves the order through the
// order_fulfillment link and sends only when `no_notification` is not set. A
// tracking number/URL is included only when it really exists on the
// fulfillment's label.
export default async function orderShippedHandler({ event, container }: SubscriberArgs<Record<string, unknown>>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as {
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string) => void
  }
  const fulfillmentId = typeof event.data?.id === 'string' && event.data.id ? event.data.id : ''
  if (!fulfillmentId) {
    logger.warn('order email: shipment.created carried no fulfillment id - not sending')
    return
  }
  const noNotification = event.data?.no_notification === true
  await handleShipmentCreated(container, logger, fulfillmentId, noNotification)
}

export const config: SubscriberConfig = {
  event: 'shipment.created',
}
