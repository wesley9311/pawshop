import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { BigNumber, ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { refundPaymentWorkflow } from '@medusajs/core-flows'
import { randomUUID } from 'node:crypto'
import { acquireOrderPaymentLock } from './order-payment-lock.cjs'
import { externalRefundContext } from './paypal-external-refund-context'
import { PAWSHOP_PAYMENT_RECONCILIATION_MODULE } from '../modules/pawshop-payment-reconciliation'

const REFUNDED = 'PAYMENT.CAPTURE.REFUNDED'
const REVERSED = 'PAYMENT.CAPTURE.REVERSED'
const PAYPAL_PROVIDER_ID = 'pp_paypal_paypal'

type Json = Record<string, any>

function fixed(value: unknown): string | null {
  try {
    const result = new BigNumber(value as any).numeric.toFixed(2)
    return /^\d+\.\d{2}$/.test(result) ? result : null
  } catch {
    return null
  }
}

function header(req: MedusaRequest, name: string): string {
  const value = req.headers[name.toLowerCase()]
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

const isolation = require('./paypal-environment.cjs')
async function paypalGet(path: string, auth: {environment:string,config:any}): Promise<Json> {
  return isolation.request(auth.environment, 'GET', path, undefined, {}, auth.config)
}

function sum(rows: any[]): number {
  return rows.reduce((total, row) => total + Number(row?.raw_amount?.value ?? row?.amount ?? 0), 0)
}

async function findPayment(req: MedusaRequest, captureId: string, environment: string) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const result = await query.graph({
    entity: 'payment',
    fields: [
      'id', 'provider_id', 'data', 'payment_session_id', 'amount', 'raw_amount', 'currency_code',
      'payment_collection.id', 'payment_collection.order.id', 'payment_session.data', 'payment_collection.payment_sessions.data', 'payment_collection.payments.data',
      'captures.id', 'captures.amount', 'captures.raw_amount',
      'refunds.id', 'refunds.amount', 'refunds.raw_amount', 'refunds.metadata',
    ],
    filters: { provider_id: PAYPAL_PROVIDER_ID },
    pagination: { take: 1000 },
  })
  return (result.data || []).filter((payment: any) => payment?.data?.capture_id === captureId &&
    isolation.sameEnvironment(payment.data, payment.payment_session?.data,
      ...(payment.payment_collection.payment_sessions||[]).map((s:any)=>s.data),
      ...(payment.payment_collection.payments||[]).map((p:any)=>p.data)) === environment)
}

async function ensureExternalRefundFacts(req: MedusaRequest, payment: any, event: Json, amount: number) {
  const orderModule = req.scope.resolve(Modules.ORDER) as any
  const externalId = event.resource.id
  const metadata = {
    paypal_external_event_id: event.id,
    paypal_refund_id: externalId,
    paypal_capture_id: event.resource.supplementary_data.related_ids.capture_id,
    source: 'paypal_webhook',
    paypal_environment: isolation.environmentOf(payment.data),
  }
  let refund = (payment.refunds || []).find((row: any) =>
    row?.metadata?.paypal_external_event_id === event.id ||
    row?.metadata?.paypal_refund_id === externalId
  )
  // A Medusa-initiated refund has already created its local row before PayPal
  // emits REFUNDED. The provider persists the PayPal refund id on payment.data;
  // adopt that existing row rather than recording a second refund.
  const mappedRefundId = payment.data?.refund_map?.[externalId]
  if (!refund && mappedRefundId) {
    refund = (payment.refunds || []).find((row: any) => row.id === mappedRefundId)
  }
  if (!refund) {
    if (payment.data?.refund_id === externalId) throw new Error('legacy_refund_relation_requires_review')
    // Use the official refund workflow for collection totals, order transaction
    // and credit lines. Its provider call is scoped to a verified external
    // refund: the PawShop provider GETs and adopts it without another POST.
    const input = {
      payment_id: payment.id,
      amount,
      note: 'Externally completed PayPal refund adopted from a verified webhook.',
      metadata,
    }
    await externalRefundContext.run({
      environment: isolation.environmentOf(payment.data),
      refundId: externalId, captureId: metadata.paypal_capture_id,
      amount: amount.toFixed(2), currency: String(payment.currency_code).toUpperCase(),
    }, () => refundPaymentWorkflow(req.scope).run({ input }))
    return
  }
  if (fixed(refund.raw_amount?.value ?? refund.amount) !== amount.toFixed(2)) {
    throw new Error('local_refund_amount_mismatch')
  }

  const orderId = payment.payment_collection.order.id
  const existingTransactions = await orderModule.listOrderTransactions({ reference_id: refund.id, reference: 'refund' })
  if (!existingTransactions.length) throw new Error('incomplete_refund_workflow_requires_review')
  return { refundId: refund.id, orderId }
}

export async function reconcilePayPalExternalPayment(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
) {
  const event = req.body as Json
  if (![REFUNDED, REVERSED].includes(event?.event_type)) return next()

  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const ledger = req.scope.resolve(PAWSHOP_PAYMENT_RECONCILIATION_MODULE) as any
  const locking = req.scope.resolve(Modules.LOCKING) as any
  const eventId = typeof event.id === 'string' ? event.id : ''
  const externalId = typeof event.resource?.id === 'string' ? event.resource.id : ''
  if (!eventId || !externalId) return res.status(400).json({ message: 'Invalid PayPal event.' })

  const ownerId = randomUUID()
  // Resource-level locking also serializes two different event IDs referring
  // to the same external refund. Each invocation has a distinct lock owner.
  let lockKey: string | undefined
  let record: any
  let captureLockKey: string | undefined
  let releaseOrderLock: (() => Promise<void>) | undefined
  try {
    const raw = (req as any).rawBody
    if(!Buffer.isBuffer(raw) || JSON.stringify(JSON.parse(raw.toString('utf8'))) !== JSON.stringify(event)) return res.sendStatus(400)
    const config = isolation.configuration()
    const environment = await isolation.verifyDual(req.headers, raw, config)
    if(!environment) return res.status(400).json({message:'Invalid PayPal signature.'})
    const auth = {environment,config}
    const identity = isolation.resourceKey(environment, externalId)
    lockKey = `paypal-reconciliation:${identity}`

    await locking.acquire(lockKey, { ownerId, expire: 60 })
    const existing = await ledger.listPaymentReconciliations({ external_id: identity })
    record = existing[0]
    if (!record) {
      const legacy = (await ledger.listPaymentReconciliations({external_id:externalId}))[0]
      if(legacy?.payment_id) {
        const p = await req.scope.resolve(Modules.PAYMENT).retrievePayment(legacy.payment_id)
        if(isolation.environmentOf(p.data)===environment) record=legacy
      }
    }
    if (record && record.status !== 'received') return res.sendStatus(200)
    if (!record) {
      record = await ledger.createPaymentReconciliations({
        provider_event_id: isolation.resourceKey(environment, eventId),
        external_id: identity,
        event_type: event.event_type === REFUNDED ? 'refund' : 'reversal',
        status: 'received',
      })
    }

    const fresh = event.event_type === REFUNDED
      ? await paypalGet(`/v2/payments/refunds/${externalId}`, auth)
      : await paypalGet(`/v2/payments/captures/${externalId}`, auth)
    const upLink = (fresh.links || []).find((link: any) => link.rel === 'up')?.href
    const linkedCaptureId = typeof upLink === 'string'
      ? /^https:\/\/api(?:-m)?\.(?:sandbox\.)?paypal\.com\/v2\/payments\/captures\/([A-Za-z0-9_-]+)$/.exec(upLink)?.[1]
      : undefined
    const incomingCaptureId = event.resource?.supplementary_data?.related_ids?.capture_id
    const captureId = event.event_type === REFUNDED
      ? (fresh.supplementary_data?.related_ids?.capture_id || linkedCaptureId || incomingCaptureId)
      : fresh.id
    if (typeof captureId === 'string') {
      captureLockKey = `paypal-reconciliation-capture:${isolation.resourceKey(environment, captureId)}`
      await locking.acquire(captureLockKey, { ownerId, expire: 120 })
    }
    const amountText = fixed(fresh.amount?.value)
    const currency = typeof fresh.amount?.currency_code === 'string'
      ? fresh.amount.currency_code.toUpperCase()
      : ''
    const matches = typeof captureId === 'string' ? await findPayment(req, captureId, environment) : []
    let payment = matches.length === 1 ? matches[0] : null
    const orderId = payment?.payment_collection?.order?.id || null

    const review = async (reason: string) => {
      await ledger.updatePaymentReconciliations({
        id: record.id, capture_id: captureId || null, payment_id: payment?.id || null,
        order_id: orderId, amount: amountText, currency_code: currency || null,
        status: 'review', reason, resolved_at: new Date(),
      })
      logger.error(`PayPal reconciliation requires review: ${reason}; event=${eventId}`)
      return res.sendStatus(200)
    }

    if (fresh.id !== externalId) return await review('provider_resource_mismatch')
    if (fresh.supplementary_data?.related_ids?.capture_id && incomingCaptureId &&
        fresh.supplementary_data.related_ids.capture_id !== incomingCaptureId) {
      return await review('capture_relation_mismatch')
    }
    const capture = typeof captureId === 'string'
      ? await paypalGet(`/v2/payments/captures/${encodeURIComponent(captureId)}`, auth)
      : null
    if (!capture || capture.id !== captureId ||
        capture.amount?.currency_code !== currency ||
        fixed(capture.amount?.value) !== fixed(payment?.raw_amount?.value ?? payment?.amount)) {
      return await review('capture_fact_mismatch')
    }
    if (capture.supplementary_data?.related_ids?.order_id !== payment?.data?.id ||
        capture.custom_id !== payment?.payment_session_id) {
      return await review('capture_order_session_mismatch')
    }
    if (!payment || !amountText || !currency) return await review('payment_relation_unresolved')
    if (matches.length !== 1) return await review('payment_relation_ambiguous')
    if (currency !== String(payment.currency_code || '').toUpperCase()) return await review('currency_mismatch')
    if (!orderId) return await review('order_relation_unresolved')
    releaseOrderLock = await acquireOrderPaymentLock(req.scope, orderId)
    const current = await findPayment(req, captureId, environment)
    if (current.length !== 1 || current[0].id !== payment.id ||
        current[0].payment_collection?.order?.id !== orderId) return await review('payment_relation_changed')
    payment = current[0]
    await ledger.updatePaymentReconciliations({ id: record.id, capture_id: captureId, payment_id: payment.id, order_id: orderId })
    const captured = sum(payment.captures || [])
    const refunded = sum(payment.refunds || [])
    const amount = Number(amountText)
    const alreadyRecorded = Boolean(payment.data?.refund_map?.[externalId]) || (payment.refunds || []).some((row: any) =>
      row?.metadata?.paypal_external_event_id === eventId || row?.metadata?.paypal_refund_id === externalId
    )
    if (amount <= 0 || (!alreadyRecorded && refunded + amount > captured + 0.000001)) {
      return await review('refund_amount_invalid')
    }
    if (event.event_type === REVERSED) return await review('paypal_capture_reversed')
    if (fresh.status !== 'COMPLETED') return await review('paypal_refund_not_completed')

    await ensureExternalRefundFacts(req, payment, { ...event, resource: {
      ...fresh, supplementary_data: { ...fresh.supplementary_data,
        related_ids: { ...fresh.supplementary_data?.related_ids, capture_id: captureId } },
    } }, amount)
    await ledger.updatePaymentReconciliations({
      id: record.id, capture_id: captureId, payment_id: payment.id, order_id: orderId,
      amount: amountText, currency_code: currency, status: 'applied', reason: null,
      resolved_at: new Date(),
    })
    return res.sendStatus(200)
  } catch (error) {
    if(record && /paypal_environment_/.test((error as Error).message)) {
      await ledger.updatePaymentReconciliations({id:record.id,status:'review',reason:'paypal_environment_unverified',resolved_at:new Date()})
      logger.error('PayPal reconciliation requires review: paypal_environment_unverified')
      return res.sendStatus(200)
    }
    logger.error(`PayPal reconciliation failed: ${(error as Error).message}`)
    return res.status(503).json({ message: 'PayPal reconciliation unavailable.' })
  } finally {
    if (releaseOrderLock) { try { await releaseOrderLock() } catch {} }
    if (captureLockKey) { try { await locking.release(captureLockKey, { ownerId }) } catch {} }
    if(lockKey) { try { await locking.release(lockKey, { ownerId }) } catch {} }
  }
}
