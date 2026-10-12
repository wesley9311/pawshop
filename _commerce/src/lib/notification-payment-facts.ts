// Provider-neutral facts for customer notifications. Adapters only read payment
// providers; rendering and delivery never know which provider was used.
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
type Json = Record<string, any>
const money = (value: any) => Math.round(Number(value?.value ?? value) * 100)
async function paypalRead(path: string) {
  const base = process.env.PAYPAL_SANDBOX === 'true' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'
  const auth = await fetch(base + '/v1/oauth2/token', { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { authorization: 'Basic ' + Buffer.from((process.env.PAYPAL_CLIENT_ID || '') + ':' + (process.env.PAYPAL_CLIENT_SECRET || '')).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  if (!auth.ok) throw Error('notification_payment_read_unavailable')
  const token: any = await auth.json()
  const response = await fetch(base + path, { signal: AbortSignal.timeout(10000), headers: { authorization: 'Bearer ' + token.access_token } })
  if (!response.ok) throw Error('notification_payment_read_unavailable')
  return await response.json() as Json
}
function identifier(id: any) { if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw Error('notification_payment_relation_invalid'); return id }
const adapters: Record<string, any> = {
  pp_paypal_paypal: {
    async payment(payment: Json, sessionOnly = false) {
      const order = await paypalRead('/v2/checkout/orders/' + identifier(payment.data?.id))
      if (order.id !== payment.data.id || order.purchase_units?.length !== 1 ||
          order.purchase_units[0].custom_id !== payment.payment_session_id) throw Error('notification_payment_relation_invalid')
      const unit = order.purchase_units[0], captures = unit.payments?.captures || [], authorizations = unit.payments?.authorizations || []
      const currency = String(payment.currency_code).toUpperCase()
      if (unit.amount?.currency_code !== currency || money(unit.amount.value) !== money(payment.amount)) throw Error('notification_payment_amount_invalid')
      if (captures.length > 1 || authorizations.length > 1) throw Error('notification_payment_relation_invalid')
      const capture = captures[0]
      if (capture && (((!sessionOnly || payment.data?.capture_id) && capture.id !== payment.data?.capture_id) || capture.amount?.currency_code !== currency || money(capture.amount.value) !== money(payment.amount))) throw Error('notification_payment_amount_invalid')
      return { captureId: capture?.id, captureStatus: capture?.status, authorization: authorizations[0]?.status === 'VOIDED' ? 'voided' : authorizations.length ? 'authorized' : 'none' }
    },
    async refund(payment: Json, externalId: string, amount: any) {
      const record = await paypalRead('/v2/payments/refunds/' + identifier(externalId))
      const link = record.links?.find((l: any) => l.rel === 'up')?.href
      const captureId = record.supplementary_data?.related_ids?.capture_id ||
        (typeof link === 'string' ? /^https:\/\/api(?:-m)?\.(?:sandbox\.)?paypal\.com\/v2\/payments\/captures\/([A-Za-z0-9_-]+)$/.exec(link)?.[1] : null)
      if (record.id !== externalId || captureId !== payment.data?.capture_id || record.amount?.currency_code !== String(payment.currency_code).toUpperCase() || money(record.amount.value) !== money(amount)) throw Error('notification_refund_relation_invalid')
      return record.status === 'COMPLETED' ? 'completed' : record.status === 'PENDING' ? 'processing' : ['FAILED', 'CANCELLED', 'DENIED'].includes(record.status) ? 'failed' : 'unknown'
    },
  },
}
async function paymentForOrder(container: any, paymentId: string) {
  const result = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'payment',
    fields: ['id', 'provider_id', 'payment_session_id', 'data', 'amount', 'currency_code', 'captured_at', 'captures.*', 'refunds.*', 'payment_collection.order.id'], filters: { id: paymentId } })
  if (result.data.length !== 1 || !result.data[0].payment_collection?.order?.id) throw Error('notification_payment_relation_invalid')
  return result.data[0]
}
export async function resolveRefundOrder(container: any, id: string) {
  const refund = await container.resolve(Modules.PAYMENT).retrieveRefund(id)
  const payment = await paymentForOrder(container, refund.payment_id)
  return { refund, payment, orderId: payment.payment_collection.order.id }
}
export async function completedRefundFacts(container: any, id: string) {
  const { refund, payment, orderId } = await resolveRefundOrder(container, id)
  const adapter = adapters[payment.provider_id]
  if (!adapter || !payment.captured_at) throw Error('notification_refund_unverified')
  const paid = await adapter.payment(payment)
  if (!['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(paid.captureStatus)) throw Error('notification_refund_unverified')
  const external = Object.entries(payment.data?.refund_map || {}).find(([, local]) => local === id)?.[0]
  if (!external || await adapter.refund(payment, external, refund.amount) !== 'completed') throw Error('notification_refund_unverified')
  return { verified: true, orderId, amount: money(refund.amount) / 100, currency: String(payment.currency_code).toUpperCase(), state: 'completed' }
}
export async function cancellationFacts(container: any, orderId: string) {
  const result = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'order', fields: ['id', 'status', 'currency_code', 'payment_collections.payments.id', 'payment_collections.payment_sessions.*'], filters: { id: orderId } })
  const order = result.data[0]
  if (order?.status !== 'canceled') throw Error('notification_order_not_cancelled')
  const payments = (order.payment_collections || []).flatMap((c: any) => c.payments || [])
  let captured = 0, refunded = 0, authorization = 'none', unknown = false
  const seen = new Set<string>()
  for (const row of payments) {
    const p = await paymentForOrder(container, row.id), adapter = adapters[p.provider_id]
    if (p.payment_collection.order.id !== orderId || !adapter) { unknown = true; continue }
    seen.add(p.payment_session_id)
    const proof = await adapter.payment(p)
    if (proof.authorization === 'authorized' && !p.captured_at) authorization = 'authorized'
    else if (proof.authorization === 'voided' && authorization === 'none') authorization = 'voided'
    if (p.captured_at && ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(proof.captureStatus)) captured += money(p.amount)
    else if (proof.captureStatus) unknown = true
    for (const r of p.refunds || []) {
      const external = Object.entries(p.data?.refund_map || {}).find(([, local]) => local === r.id)?.[0]
      if (external && await adapter.refund(p, external, r.amount) === 'completed') refunded += money(r.amount)
      else unknown = true
    }
  }
  for (const session of (order.payment_collections || []).flatMap((c:any)=>c.payment_sessions||[])) {
    if (seen.has(session.id)) continue
    const adapter=adapters[session.provider_id]
    if(!adapter){unknown=true;continue}
    const proof=await adapter.payment({...session,payment_session_id:session.id},true)
    // No Payment row does not prove no provider authorization/capture. A
    // provider-side fact without its local payment relationship needs review.
    if(proof.captureStatus || proof.authorization==='authorized')unknown=true
    else if(proof.authorization==='voided' && authorization==='none')authorization='voided'
  }
  if(captured>0 && authorization==='authorized')unknown=true
  return { verified: true, currency: String(order.currency_code).toUpperCase(), captured: captured / 100, refunded: refunded / 100, authorization, unknown }
}
export async function reviewRefundFacts(container: any, recordId: string) {
  const ledger = container.resolve('pawshopPaymentReconciliation')
  const rows = await ledger.listPaymentReconciliations({ id: recordId })
  const row = rows[0]
  if (!row || row.status !== 'review' || row.event_type !== 'refund' || !row.order_id || !row.payment_id) throw Error('notification_review_not_current')
  const payment = await paymentForOrder(container, row.payment_id), adapter = adapters[payment.provider_id]
  if (payment.payment_collection.order.id !== row.order_id || row.capture_id !== payment.data?.capture_id || String(row.currency_code).toUpperCase() !== String(payment.currency_code).toUpperCase() || !adapter) throw Error('notification_refund_relation_invalid')
  await adapter.payment(payment)
  const state = await adapter.refund(payment, row.external_id, row.amount)
  return { verified: true, orderId: row.order_id, amount: money(row.amount) / 100, currency: String(payment.currency_code).toUpperCase(), state: state === 'processing' ? 'processing' : 'review' }
}
