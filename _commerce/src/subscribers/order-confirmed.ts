import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { handleOrderPlaced } from '../lib/order-notification-subscriber-helper'

// order.placed → "Order confirmed".
//
// This subscriber stays thin: it reads the order id from the event and delegates
// every remaining step (query the order, claim idempotency, read credentials,
// render and send) to the shared helper. It logs only a coarse outcome — the
// customer's email and order data never reach the journal.
export default async function orderConfirmedHandler({ event, container }: SubscriberArgs<Record<string, unknown>>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as {
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string) => void
  }
  const orderId = typeof event.data?.id === 'string' && event.data.id ? event.data.id : ''
  if (!orderId) {
    logger.warn('order email: order.placed carried no order id - not sending')
    return
  }
  await handleOrderPlaced(container, logger, orderId)
}

export const config: SubscriberConfig = {
  event: 'order.placed',
}
