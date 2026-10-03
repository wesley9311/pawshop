import { Module } from '@medusajs/framework/utils'
import PawshopCustomerAuthService from './service'

// PawShop's customer-account claim audit ledger.
//
// It owns one table and nothing else. It has no relations into the commerce
// models, so the migration below only ever ADDS a table: no core commerce table
// is altered, and dropping this module can never touch commerce data.
//
// The actual claim decision (upgrade a guest customer vs create a new account)
// lives in the store `customers` route + `src/lib/customer-claim.cjs`; this
// module is only the durable "who was bound to whom" ledger that makes claims
// auditable and idempotent.
export const PAWSHOP_CUSTOMER_AUTH_MODULE = 'pawshopCustomerAuth'

export default Module(PAWSHOP_CUSTOMER_AUTH_MODULE, {
  service: PawshopCustomerAuthService,
})
