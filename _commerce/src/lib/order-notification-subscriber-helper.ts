import type { SubscriberArgs } from '@medusajs/framework'
import { refetchEntities } from '@medusajs/framework/http'
import { getOrderDetailWorkflow } from '@medusajs/core-flows'
import { PAWSHOP_NOTIFICATION_MODULE } from '../modules/pawshop-notification'
import {
  buildIdempotencyKey,
  classifySmtpError,
  computeNextAttemptAt,
  deliverOrderEmail,
  isRetryable,
  NOTIFICATION_TYPES,
  normalizeOrder,
  readFromName,
  readSupportEmail,
  safeTrackingNumber,
  safeTrackingUrl,
  shouldSendNotification,
} from './transactional-order-email.cjs'
import { readEmailCredentials } from './email-channel.cjs'
import { buildPublicOrderNumber } from './order-lookup.cjs'
import type { SendClaim } from '../modules/pawshop-notification/service'

// Shared orchestration for the three customer-notification subscribers.
//
// Each subscriber is thin: it resolves its event into an order id (or a
// fulfillment id) and calls one of the handlers below. Everything the three
// flows have in common — the fulfillment→order join, the order query, the
// idempotency claim, the credential read, the delivery — lives here once, not
// three times. The pure, unit-testable parts (idempotency keys, templates,
// tracking-url validation) live in `transactional-order-email.cjs`; what stays
// here is the Medusa-runtime I/O.

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
type Container = SubscriberArgs<unknown>['container']

// The fields the order query must return for any notification. `public_order_number`
// is not a stored column — it is derived from `display_id` + `created_at` by the
// caller — so it is assembled after the query, not requested from it.
const ORDER_FIELDS = [
  'id',
  'display_id',
  'currency_code',
  'total',
  'created_at',
  'email',
  'items.title',
  'items.quantity',
  'items.total',
  'shipping_methods.name',
  'shipping_address.first_name',
  'shipping_address.last_name',
  'shipping_address.address_1',
  'shipping_address.city',
  'shipping_address.province',
  'shipping_address.postal_code',
  'shipping_address.country_code',
  'fulfillments.id',
  'fulfillments.labels.tracking_number',
  'fulfillments.labels.tracking_url',
]

type ResolvedOrder = {
  id: string
  display_id: number
  currency_code: string
  total: number | string
  created_at: string
  email: string
  items: Array<{ title: string; quantity: number; total: number | string }>
  shipping_methods: Array<{ name: string | null }> | null
  shipping_address: {
    first_name: string | null
    last_name: string | null
    address_1: string | null
    city: string | null
    province: string | null
    postal_code: string | null
    country_code: string | null
  } | null
  fulfillments: Array<{
    id: string
    labels: Array<{ tracking_number: string | null; tracking_url: string | null }> | null
  }> | null
}

// shipment.created / delivery.created carry only the fulfillment id. The
// fulfillment → order relationship is a Medusa link (`order_fulfillment`), not a
// column on the fulfillment, so the order id is resolved through that link.
async function resolveOrderIdFromFulfillment(container: Container, fulfillmentId: string): Promise<string | null> {
  const link = await refetchEntities({
    entity: 'order_fulfillment',
    idOrFilter: { fulfillment_id: fulfillmentId },
    scope: container,
    fields: ['order_id'],
  })
  const row = (link.data?.[0] as { order_id?: string } | undefined)
  return row?.order_id ?? null
}

// Fetch an order by id through the official order-detail workflow (the same
// source the guest lookup uses), then derive the public order number.
async function fetchOrder(container: Container, orderId: string) {
  const { result } = await getOrderDetailWorkflow(container).run({
    input: {
      order_id: orderId,
      filters: { is_draft_order: false },
      fields: ORDER_FIELDS,
    },
  })
  if (!result) return null
  const order = result as unknown as ResolvedOrder
  return { ...order, public_order_number: buildPublicOrderNumber(order.display_id, order.created_at) }
}

// The tracking label for a specific fulfillment, if it exists. `label_url` is
// never requested (it is the warehouse's shipping-label artifact, not
// buyer-visible data); only the tracking number/URL are read and validated.
function trackingForFulfillment(order: ResolvedOrder, fulfillmentId: string) {
  const fulfillment = (order.fulfillments || []).find((f) => f.id === fulfillmentId)
  if (!fulfillment) return { trackingNumber: null, trackingUrl: null }
  const label = (fulfillment.labels || [])[0]
  return {
    trackingNumber: safeTrackingNumber(label?.tracking_number ?? null),
    trackingUrl: safeTrackingUrl(label?.tracking_url ?? null),
  }
}

// The single send path, driven by the durable send-state machine.
//
//   tryClaim  →  claim  →  re-query order + send  →  markSent      (terminal)
//                                   └─ transient fail ─→  markFailed (retry scheduled)
//                                   └─ permanent fail ─→  markTerminal
//   tryClaim  →  skip_sent      →  already delivered, do nothing
//   tryClaim  →  skip_terminal  →  permanent terminal, do nothing
//   tryClaim  →  in_flight      →  another worker / backoff not elapsed, do nothing
//
// The idempotency key is unique, but `sent` — not the claim — is the success
// terminal state. A transient SMTP failure marks the row `failed` with a
// scheduled `next_attempt_at`, which the recovery worker claims again later, so
// a relay hiccup is a retry, not a deterministic drop. A permanent error (bad
// recipient, auth failure, missing order, bad config) marks the row `terminal`
// so it never retries forever. A worker that dies mid-send leaves the row
// `sending` with an expiring lease; once the lease lapses, the recovery worker
// takes it over (crash recovery).
//
// Every retry re-queries the live order/fulfillment by notification_type +
// entity_id, so the email always reflects the current tracking/order data — the
// persisted row only holds non-sensitive locating fields.
//
// The returned string is a coarse status for the subscriber's log line. It never
// carries the recipient address, order data, the relay's raw error text, or any
// credential — only the non-sensitive error category is persisted.
async function sendOnce(
  container: Container,
  logger: Logger,
  type: string,
  entityId: string,
  orderId: string,
  fulfillmentId?: string,
): Promise<string> {
  const key = buildIdempotencyKey(type, entityId)
  if (!key) {
    logger.warn(`order email: skipped - cannot derive an idempotency key for ${type}`)
    return 'skipped'
  }

  const notification = container.resolve(PAWSHOP_NOTIFICATION_MODULE) as {
    tryClaim: (input: { idempotencyKey: string; notificationType: string; entityId: string; now: Date }) => Promise<SendClaim>
    markSent: (input: { idempotencyKey: string; now: Date }) => Promise<void>
    markFailed: (input: { idempotencyKey: string; errorCategory: string; retryable: boolean; nextAttemptAt: string; now: Date }) => Promise<void>
    markTerminal: (input: { idempotencyKey: string; errorCategory: string; now: Date }) => Promise<void>
  }

  let claim: SendClaim
  try {
    claim = await notification.tryClaim({ idempotencyKey: key, notificationType: type, entityId, now: new Date() })
  } catch (error) {
    logger.error(`order email: claim failed for ${type} - ${error instanceof Error ? error.message : String(error)}`)
    return 'error'
  }

  if (claim.state === 'skip_sent') {
    logger.info(`order email: already sent - ${type}`)
    return 'duplicate'
  }
  if (claim.state === 'skip_terminal') {
    logger.info(`order email: terminal (will not retry) - ${type}`)
    return 'terminal'
  }
  if (claim.state === 'in_flight') {
    logger.info(`order email: in flight elsewhere - ${type}`)
    return 'in_flight'
  }

  // claim.state === 'claim': this worker owns the lease and must attempt the send.
  const order = await fetchOrder(container, orderId)
  if (!order) {
    logger.warn(`order email: skipped - order not found for ${type}`)
    // The order is gone and will not come back — a permanent, non-retryable
    // condition (e.g. the workflow compensated and deleted it). Terminal.
    await notification.markTerminal({ idempotencyKey: key, errorCategory: 'missing_order', now: new Date() }).catch(() => undefined)
    return 'skipped'
  }

  const normalized = normalizeOrder(order)
  if (!normalized || !normalized.email) {
    logger.warn(`order email: skipped - order has no customer email for ${type}`)
    // No address means this event can never be delivered; mark sent so a
    // redelivery does not keep retrying a mail that has no destination.
    await notification.markSent({ idempotencyKey: key, now: new Date() }).catch(() => undefined)
    return 'skipped'
  }

  let credentials
  try {
    credentials = readEmailCredentials(undefined, { serviceGid: typeof process.getgid === 'function' ? process.getgid() : null })
  } catch (error) {
    logger.error(`order email: skipped - email credentials unusable (${error instanceof Error ? error.message : String(error)})`)
    // A broken credential/relay config is permanent — terminal, not retryable.
    await notification.markTerminal({ idempotencyKey: key, errorCategory: 'credentials', now: new Date() }).catch(() => undefined)
    return 'error'
  }

  const tracking = fulfillmentId
    ? trackingForFulfillment(order, fulfillmentId)
    : { trackingNumber: null, trackingUrl: null }

  const result = await deliverOrderEmail({
    type,
    order: normalized,
    tracking,
    credentials,
    fromName: readFromName(process.env),
    supportEmail: readSupportEmail(process.env),
  })

  if (!result.sent) {
    const category = classifySmtpError(result.error)
    const retryable = isRetryable(category, result.error)
    logger.error(`order email: failed for ${type} - ${result.reason}`)
    if (retryable) {
      // The attempt count was already incremented by tryClaim; derive the next
      // retry from that count. computeNextAttemptAt returns null on the final
      // (5th) attempt, which must go terminal rather than schedule a 6th send.
      const attempt = await readAttemptCount(container, key)
      const nextAttemptAt = computeNextAttemptAt(attempt, new Date())
      if (nextAttemptAt == null) {
        await notification.markTerminal({ idempotencyKey: key, errorCategory: 'max_attempts', now: new Date() }).catch(() => undefined)
      } else {
        await notification.markFailed({ idempotencyKey: key, errorCategory: category, retryable: true, nextAttemptAt, now: new Date() }).catch(() => undefined)
      }
    } else {
      await notification.markTerminal({ idempotencyKey: key, errorCategory: category, now: new Date() }).catch(() => undefined)
    }
    return 'error'
  }

  await notification.markSent({ idempotencyKey: key, now: new Date() }).catch(() => undefined)
  logger.info(`order email: sent - ${type}`)
  return 'sent'
}

// Read the current attempt count for an idempotency key, to derive the backoff
// for the next retry. Returns 1 if the row is somehow absent (a defensive floor
// so a failed first attempt still gets the shortest backoff).
async function readAttemptCount(container: Container, key: string): Promise<number> {
  try {
    const notification = container.resolve(PAWSHOP_NOTIFICATION_MODULE) as {
      readAttemptCount: (input: { idempotencyKey: string }) => Promise<number>
    }
    return await notification.readAttemptCount({ idempotencyKey: key })
  } catch {
    return 1
  }
}

// order.placed → Order confirmed.
export async function handleOrderPlaced(container: Container, logger: Logger, orderId: string) {
  return sendOnce(container, logger, NOTIFICATION_TYPES.ORDER_CONFIRMED, orderId, orderId)
}

// shipment.created → Order shipped. Respects `no_notification`.
export async function handleShipmentCreated(
  container: Container,
  logger: Logger,
  fulfillmentId: string,
  noNotification: boolean,
) {
  if (!shouldSendNotification(noNotification)) {
    logger.info(`order email: shipment marked no_notification - not sending`)
    return 'suppressed'
  }
  const orderId = await resolveOrderIdFromFulfillment(container, fulfillmentId)
  if (!orderId) {
    logger.warn(`order email: skipped - no order for fulfillment ${fulfillmentId}`)
    return 'skipped'
  }
  return sendOnce(container, logger, NOTIFICATION_TYPES.ORDER_SHIPPED, fulfillmentId, orderId, fulfillmentId)
}

// delivery.created → Order delivered. Respects `no_notification`.
export async function handleDeliveryCreated(
  container: Container,
  logger: Logger,
  fulfillmentId: string,
  noNotification: boolean,
) {
  if (!shouldSendNotification(noNotification)) {
    logger.info(`order email: delivery marked no_notification - not sending`)
    return 'suppressed'
  }
  const orderId = await resolveOrderIdFromFulfillment(container, fulfillmentId)
  if (!orderId) {
    logger.warn(`order email: skipped - no order for fulfillment ${fulfillmentId}`)
    return 'skipped'
  }
  return sendOnce(container, logger, NOTIFICATION_TYPES.ORDER_DELIVERED, fulfillmentId, orderId, fulfillmentId)
}

// Recovery entry point, driven by the scheduled retry worker. Given a row's
// notification_type + entity_id (the only locating fields persisted), it
// re-resolves the order and re-claims the lease through the same sendOnce path.
// For an order-confirmed notification the entity id is the order id; for a
// shipped/delivered notification it is the fulfillment id and the order id is
// re-resolved through the order_fulfillment link.
export async function retryOnce(
  container: Container,
  logger: Logger,
  notificationType: string,
  entityId: string,
): Promise<string> {
  if (notificationType === NOTIFICATION_TYPES.ORDER_CONFIRMED) {
    return sendOnce(container, logger, notificationType, entityId, entityId)
  }
  if (notificationType === NOTIFICATION_TYPES.ORDER_SHIPPED || notificationType === NOTIFICATION_TYPES.ORDER_DELIVERED) {
    const orderId = await resolveOrderIdFromFulfillment(container, entityId)
    if (!orderId) {
      // The fulfillment no longer resolves to an order — permanent.
      const key = buildIdempotencyKey(notificationType, entityId)
      if (key) {
        const notification = container.resolve(PAWSHOP_NOTIFICATION_MODULE) as {
          markTerminal: (input: { idempotencyKey: string; errorCategory: string; now: Date }) => Promise<void>
        }
        await notification.markTerminal({ idempotencyKey: key, errorCategory: 'missing_order', now: new Date() }).catch(() => undefined)
      }
      logger.warn(`order email: recovery skipped - no order for fulfillment ${entityId}`)
      return 'skipped'
    }
    return sendOnce(container, logger, notificationType, entityId, orderId, entityId)
  }
  logger.warn(`order email: recovery skipped - unknown notification type ${notificationType}`)
  return 'skipped'
}
