import { Modules } from '@medusajs/framework/utils'
import { processPaymentWorkflow } from '@medusajs/core-flows'
// Existing durable payment sessions are the recovery worklist. Never depend
// on a browser refresh or on webhook delivery, and never invent payment facts.
export async function convergePayPalSessions(container: any) {
  const payment = container.resolve(Modules.PAYMENT)
  const logger = container.resolve('logger')
  let skip = 0, repaired = 0, failures = 0
  for (;;) {
    const sessions = await payment.listPaymentSessions({ provider_id: 'pp_paypal_paypal' },
      { take: 100, skip, order: { id: 'ASC' }, relations: ['payment', 'payment.captures', 'payment_collection'] })
    for (const session of sessions) {
      if (session.data?.auto_capture_policy !== 'pawshop-auto-capture-v1' ||
          ['canceled', 'error'].includes(session.status)) continue
      const p = session.payment
      if (p?.captured_at && Number(session.payment_collection?.captured_amount) >= Number(session.amount)) continue
      try {
        if (!await payment.inspectPayPalSession(session.id)) continue
        // authorizePayment always reads PayPal first. Approved -> authorize and
        // capture; already captured -> adopt exact fact using official service.
        await processPaymentWorkflow(container).run({ input: {
          action: 'authorized', data: { session_id: session.id, amount: Number(session.amount) },
        } })
        // Existing-order/idempotent workflow branches may skip authorization.
        // Re-read with the serialized official service and repair aggregates.
        await payment.authorizePaymentSession(session.id, {})
        repaired++
      } catch {
        failures++
        // No secrets, provider response bodies or customer data in recovery logs.
        logger.warn(`PayPal convergence retry required; session=${session.id}`)
      }
    }
    if (sessions.length < 100) break
    skip += sessions.length
  }
  return { repaired, failures }
}
