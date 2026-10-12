import { model } from '@medusajs/framework/utils'

// Durable ledger for PayPal events that Medusa's standard webhook action set
// cannot represent. The unique provider event id is the idempotency boundary;
// an external refund/reversal is never inferred from amount alone.
export const PaymentReconciliation = model.define('PaymentReconciliation', {
  id: model.id({ prefix: 'payrec' }).primaryKey(),
  provider_event_id: model.text(),
  external_id: model.text(),
  event_type: model.enum(['refund', 'reversal']),
  capture_id: model.text().nullable(),
  payment_id: model.text().nullable(),
  order_id: model.text().nullable(),
  amount: model.text().nullable(),
  currency_code: model.text().nullable(),
  status: model.enum(['received', 'applied', 'review']),
  reason: model.text().nullable(),
  resolved_at: model.dateTime().nullable(),
}).indexes([
  { name: 'IDX_payment_reconciliation_provider_event_unique', on: ['provider_event_id'], unique: true },
  { name: 'IDX_payment_reconciliation_external_id', on: ['external_id'], unique: true },
  { name: 'IDX_payment_reconciliation_order_status', on: ['order_id', 'status'] },
])
