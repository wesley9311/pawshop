import { Module } from '@medusajs/framework/utils'
import PawshopPaymentReconciliationService from './service'

export const PAWSHOP_PAYMENT_RECONCILIATION_MODULE = 'pawshopPaymentReconciliation'

export default Module(PAWSHOP_PAYMENT_RECONCILIATION_MODULE, {
  service: PawshopPaymentReconciliationService,
})
