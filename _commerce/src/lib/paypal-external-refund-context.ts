import { AsyncLocalStorage } from 'node:async_hooks'

// Only trusted backend reconciliation code can establish this context. It is
// never populated from an Admin request body or provider payment.data.
export type ExternalRefund = {
  refundId: string
  captureId: string
  amount: string
  currency: string
}
export const externalRefundContext = new AsyncLocalStorage<ExternalRefund>()
