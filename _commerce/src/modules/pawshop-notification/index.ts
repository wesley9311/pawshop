import { Module } from '@medusajs/framework/utils'
import PawshopNotificationService from './service'

// PawShop's idempotency store for customer transactional email.
//
// It owns one table and nothing else. It has no relations into the commerce
// models, so the migration below only ever ADDS a table: no core commerce table
// is altered, and dropping this module can never touch commerce data.
//
// The actual email rendering and delivery live in
// `src/lib/transactional-order-email.cjs` and the subscribers — this module is
// only the durable "already sent" ledger that makes those sends at-most-once.
export const PAWSHOP_NOTIFICATION_MODULE = 'pawshopNotification'

export default Module(PAWSHOP_NOTIFICATION_MODULE, {
  service: PawshopNotificationService,
})
