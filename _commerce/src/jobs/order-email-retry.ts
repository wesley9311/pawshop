import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { PAWSHOP_NOTIFICATION_MODULE } from '../modules/pawshop-notification'
import { retryOnce } from '../lib/order-notification-subscriber-helper'

// Recovery worker for customer transactional email.
//
// The event bus does not redeliver (production jobOptions leave `attempts` at the
// default of 1), and a subscriber never rethrows, so a transient SMTP failure
// would otherwise be a silent drop. This scheduled job is the retry driver: it
// scans the durable send-state table for rows that are eligible to be (re)sent —
// `failed` rows whose backoff (`next_attempt_at`) has elapsed, and stale
// `sending` rows whose lease expired because the sending worker crashed — and
// re-drives each through the same claim → re-query → send path as the original
// subscriber.
//
// The scan returns only non-sensitive locating fields (notification_type +
// entity_id); `retryOnce` then re-queries the live order/fulfillment so every
// retry reflects the current tracking/order data. Nothing here logs an email
// address, an order total, a tracking value, or a credential.
export default async function orderEmailRetryJob(
  container: MedusaContainer,
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as {
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string) => void
  }
  const notification = container.resolve(PAWSHOP_NOTIFICATION_MODULE) as {
    scanEligible: (now: Date, limit: number) => Promise<Array<{
      idempotency_key: string
      notification_type: string
      entity_id: string
      attempt_count: number
    }>>
  }

  let rows
  try {
    rows = await notification.scanEligible(new Date(), 100)
  } catch (error) {
    logger.error(`order email: recovery scan failed - ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  if (!rows.length) return

  // Process each eligible row independently. Two recovery workers racing for the
  // same row are resolved by the atomic tryClaim inside retryOnce: only one can
  // take the lease, the other gets skip/in_flight.
  for (const row of rows) {
    try {
      await retryOnce(container, logger, row.notification_type, row.entity_id)
    } catch (error) {
      logger.error(`order email: recovery attempt failed - ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export const config = {
  name: 'order-email-retry',
  schedule: { interval: 60 * 1000, concurrency: 'forbid' },
}
