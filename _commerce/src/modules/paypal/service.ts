import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
} from '@medusajs/framework/utils'
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  ProviderWebhookPayload,
  WebhookActionResult,
} from '@medusajs/framework/types'
import type { Logger } from '@medusajs/framework/types'
const isolation = require('../../lib/paypal-environment.cjs')
import { externalRefundContext } from '../../lib/paypal-external-refund-context'

// PayPal Orders API v2 — redirect (authorize/capture) integration.
//
// This provider deliberately implements the *redirect* flow: initiatePayment
// creates a PayPal order whose `intent` is AUTHORIZE and returns an approval
// URL (in `data.approval_url`) that the storefront opens in a new tab. The
// buyer approves on PayPal, PayPal redirects back to the storefront's return
// URL, and then either the webhook (CHECKOUT.ORDER.APPROVED → authorized) or
// the storefront's completion request authorizes the order inside Medusa.
// PawShop keeps AUTHORIZE intent, then captures server-side as part of the
// authorization call. Returning `captured` lets Medusa create its Payment and
// Capture facts atomically after PayPal confirms the full amount.

type Options = {
  // Sandbox or live client credentials from developer.paypal.com.
  client_id: string
  client_secret: string
  // true → PayPal sandbox; false → PayPal live.
  sandbox: boolean
  // The PayPal "Webhook ID" the merchant configured in the developer console.
  webhook_id: string
  // Return URL the buyer is redirected to after approving (frontend success page).
  return_url: string
  // Cancel URL the buyer is redirected to when they cancel on PayPal.
  cancel_url: string
}

type InjectedDependencies = {
  logger: Logger
}

const API_BASE = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
}

const APPROVAL_BASE = {
  sandbox: 'https://www.sandbox.paypal.com',
  live: 'https://www.paypal.com',
}

// PayPal event types we act on. Only the ones that change a Medusa payment's
// state are mapped; everything else returns `not_supported` so the framework
// ignores it instead of mis-resolving a payment session.
const WEBHOOK_EVENTS = {
  APPROVED: 'CHECKOUT.ORDER.APPROVED',
  COMPLETED: 'PAYMENT.CAPTURE.COMPLETED',
  DENIED: 'PAYMENT.CAPTURE.DENIED',
  REFUNDED: 'PAYMENT.CAPTURE.REFUNDED',
  REVERSED: 'PAYMENT.CAPTURE.REVERSED',
} as const

class PayPalPaymentProviderService extends AbstractPaymentProvider<Options> {
  static identifier = 'paypal'

  protected readonly contract_: any
  protected readonly logger_: Logger
  protected readonly options_: Options
  protected readonly apiBase_: string
  protected readonly approvalBase_: string
  // Cached OAuth token (valid ~8h). Refreshed lazily on 401.
  private token_: { value: string; expiresAt: number } | null = null

  constructor(container: InjectedDependencies, options: Options) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = options
    this.contract_ = isolation.configuration(process.env, options)
    this.apiBase_ = options.sandbox ? API_BASE.sandbox : API_BASE.live
    this.approvalBase_ = options.sandbox ? APPROVAL_BASE.sandbox : APPROVAL_BASE.live
  }

  activeEnvironment(): 'sandbox' | 'live' { return this.contract_.active }

  static validateOptions(options: Record<string, unknown>): void {
    const required = ['client_id', 'client_secret', 'webhook_id', 'return_url', 'cancel_url']
    for (const field of required) {
      if (typeof options[field] !== 'string' || !(options[field] as string).trim()) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `PayPal provider option \`${field}\` is required.`,
        )
      }
    }
    if (typeof options.sandbox !== 'boolean') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'PayPal provider option `sandbox` must be a boolean.',
      )
    }
    const urlPattern = /^https:\/\//
    for (const field of ['return_url', 'cancel_url'] as const) {
      if (!urlPattern.test(options[field] as string)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `PayPal provider option \`${field}\` must be an absolute https URL.`,
        )
      }
    }
  }

  // --- PayPal REST client (zero-dependency) -------------------------------

  private async request<T = any>(method: string, path: string, body?: Record<string, unknown>, headers?: Record<string,string>): Promise<T> {
    const environment = isolation.environmentContext.getStore()
    if (!environment) throw Error('paypal_environment_context_missing')
    return isolation.request(environment, method, path, body, headers, this.contract_)
  }
  private requestId(operation: string, providerId: string): string {
    return isolation.requestId(isolation.environmentContext.getStore(), operation, providerId)
  }

  private expectedPayment(data: Record<string, unknown> | undefined, order: PayPalOrder) {
    const unitAmount = order.purchase_units?.[0]?.amount
    const value = data?.expected_amount ?? unitAmount?.value
    const currency = data?.currency_code ?? unitAmount?.currency_code
    if ((typeof value !== 'string' && typeof value !== 'number') || typeof currency !== 'string') {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'PayPal payment is missing its expected amount or currency.',
      )
    }
    const amount = new BigNumber(value as any).numeric.toFixed(2)
    const currencyCode = typeof currency === 'string' ? currency.toUpperCase() : ''
    if (!currencyCode || !/^\d+\.\d{2}$/.test(amount)) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'PayPal payment is missing its expected amount or currency.',
      )
    }
    return { amount, currencyCode }
  }

  private captureFromOrder(
    order: PayPalOrder,
    expected: { amount: string; currencyCode: string },
  ): PayPalCapture | null {
    const captures = order.purchase_units?.flatMap((unit) => unit.payments?.captures || []) || []
    if (!captures.length) return null
    if (captures.length !== 1) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'PayPal returned an ambiguous set of captures; reconciliation is required.',
      )
    }
    this.assertExactCapture(captures[0], expected)
    if (!['COMPLETED', 'PENDING'].includes(captures[0].status)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `PayPal capture cannot be adopted (${captures[0].status || 'UNKNOWN'}).`,
      )
    }
    return captures[0]
  }

  private assertExactCapture(
    capture: PayPalCapture,
    expected: { amount: string; currencyCode: string },
  ): void {
    const captureAmount = capture.amount?.value
    const captureCurrency = capture.amount?.currency_code?.toUpperCase()
    if (typeof capture.id !== 'string' || !capture.id || typeof captureAmount !== 'string') {
      throw new MedusaError(MedusaError.Types.UNEXPECTED_STATE, 'PayPal capture is missing its id or amount.')
    }
    const normalizedAmount = new BigNumber(captureAmount as any).numeric.toFixed(2)
    if (normalizedAmount !== expected.amount || captureCurrency !== expected.currencyCode) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        'PayPal capture amount or currency does not match the authorized payment.',
      )
    }
  }

  private capturedOutput(
    externalId: string,
    authorizationId: string | null,
    capture: PayPalCapture,
    baseData: Record<string, unknown>,
  ): AuthorizePaymentOutput {
    if (capture.status !== 'COMPLETED') {
      return {
        status: 'pending_authorization',
        data: {
          ...baseData,
          id: externalId,
          status: capture.status,
          authorization_id: authorizationId,
          capture_id: capture.id,
        },
      }
    }
    return {
      status: 'captured',
      data: {
        ...baseData,
        id: externalId,
        status: capture.status,
        authorization_id: authorizationId,
        capture_id: capture.id,
      },
    }
  }

  // --- Lifecycle methods ---------------------------------------------------

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const environment = this.contract_.active
    return isolation.environmentContext.run(environment, async () => {
    const { amount, currency_code } = input
    // Medusa passes its own payment session id in `input.data.session_id` (and
    // again as `context.idempotency_key`). We must echo it into PayPal's
    // `custom_id` so the webhook can recover which Medusa session an incoming
    // PayPal event belongs to — the framework matches on that session id and
    // refuses to act when it is missing.
    const sessionId = (input.data?.session_id as string | undefined) || ''
    const order = await this.request<PayPalOrder>('POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          custom_id: sessionId,
          description: 'PawShop order',
          amount: {
            currency_code,
            value: new BigNumber(amount).numeric.toFixed(2),
          },
        },
      ],
      application_context: {
        brand_name: 'PawShop',
        // Redirect the buyer back to the storefront after approval/cancel.
        return_url: this.options_.return_url,
        cancel_url: this.options_.cancel_url,
        user_action: 'CONTINUE',
      },
    })

    const approvalUrl = order.links?.find((l) => l.rel === 'approve')?.href ?? null
    if (!approvalUrl) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'PayPal did not return an approval URL for the order.',
      )
    }

    return {
      id: order.id,
      data: {
        id: order.id,
        approval_url: approvalUrl,
        status: order.status,
        intent: 'AUTHORIZE',
        auto_capture_policy: 'pawshop-auto-capture-v1',
        paypal_environment: environment,
        expected_amount: new BigNumber(amount).numeric.toFixed(2),
        currency_code: currency_code.toUpperCase(),
      },
    }

    })
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const environment = isolation.environmentOf(input.data)
    return isolation.environmentContext.run(environment, async () => {
    const externalId = input.data?.id as string | undefined
    if (!externalId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'PayPal authorize requires the order id from initiatePayment.',
      )
    }
    // The buyer has already approved on PayPal (the redirect + webhook
    // CHECKOUT.ORDER.APPROVED signal this). Approving alone does NOT create an
    // authorization on PayPal's side: an AUTHORIZE-intent order sits at
    // `APPROVED` with an empty `payments.authorizations` until the merchant
    // calls POST /v2/checkout/orders/{id}/authorize. We must make that call
    // here, otherwise Medusa records the session as authorized (and completes
    // the cart into an order) while PayPal holds no authorization — and the
    // later capture has nothing to capture.
    let order = await this.request<PayPalOrder>('GET', `/v2/checkout/orders/${externalId}`)
    const sessionId = input.context?.idempotency_key
    if (sessionId && this.resolveSessionId(order) !== sessionId) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'PayPal order/session relation mismatch.')
    }

    if (order.status === 'APPROVED') {
      // First approval: perform the authorization and read back the new
      // authorization id. The response is the updated order (status COMPLETED).
      order = await this.request<PayPalOrder>(
        'POST',
        `/v2/checkout/orders/${externalId}/authorize`,
        {},
        { 'PayPal-Request-Id': this.requestId('authorize', externalId) },
      )
    }

    if (order.status === 'COMPLETED') {
      const authorization = order.purchase_units?.[0]?.payments?.authorizations?.[0]
      const authorizationId = authorization?.id ?? await this.findAuthorizationId(externalId)
      const expected = this.expectedPayment(input.data as Record<string, unknown>, order)
      const existingCapture = this.captureFromOrder(order, expected)
      if (existingCapture) {
        return this.capturedOutput(externalId, authorizationId, existingCapture, input.data as Record<string, unknown>)
      }

      if (!authorizationId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          'PayPal authorization completed without an authorization id.',
        )
      }

      // PawShop keeps AUTHORIZE intent, but normal checkout is auto-captured on
      // the backend immediately after authorization. This method is invoked by
      // both cart completion and the signed APPROVED webhook path, so capture
      // never depends on a browser callback. The deterministic request id makes
      // concurrent/retried calls the same PayPal operation.
      const capture = await this.request<PayPalCapture>(
        'POST',
        `/v2/payments/authorizations/${authorizationId}/capture`,
        {},
        { 'PayPal-Request-Id': this.requestId('capture', authorizationId) },
      )
      this.assertExactCapture(capture, expected)
      if (!['COMPLETED', 'PENDING'].includes(capture.status)) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `PayPal automatic capture did not complete (${capture.status || 'UNKNOWN'}).`,
        )
      }
      return this.capturedOutput(externalId, authorizationId, capture, input.data as Record<string, unknown>)
    }

    // The buyer has not approved yet (or canceled). This is not an error from
    // Medusa's perspective — the payment stays pending until the webhook or a
    // later authorize attempt observes approval.
    return {
      status: 'pending',
      data: {
        ...input.data,
        id: externalId,
        status: order.status,
      },
    }

    })
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const environment = isolation.environmentOf(input.data)
    return isolation.environmentContext.run(environment, async () => {
    const externalId = input.data?.id as string | undefined
    const order = externalId
      ? await this.request<PayPalOrder>('GET', `/v2/checkout/orders/${externalId}`)
      : null
    if (!order) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'PayPal capture requires the order id.')
    }
    const expected = this.expectedPayment(input.data as Record<string, unknown>, order)
    const existingCapture = this.captureFromOrder(order, expected)
    if (existingCapture?.status === 'COMPLETED') {
      return {
        data: {
          ...(input.data as object),
          capture_id: existingCapture.id,
          status: existingCapture.status,
        },
      }
    }
    if (existingCapture?.status === 'PENDING') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'PayPal capture is still pending; Medusa capture fact was not recorded.',
      )
    }
    const authorizationId =
      (input.data?.authorization_id as string | undefined) ||
      order?.purchase_units?.[0]?.payments?.authorizations?.[0]?.id ||
      await this.findAuthorizationId(externalId)
    if (!authorizationId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'PayPal capture requires an authorization id.',
      )
    }
    const capture = await this.request<PayPalCapture>(
      'POST',
      `/v2/payments/authorizations/${authorizationId}/capture`,
      {},
      { 'PayPal-Request-Id': this.requestId('capture', authorizationId) },
    )
    this.assertExactCapture(capture, expected)
    if (capture.status !== 'COMPLETED') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `PayPal capture was not completed (${capture.status || 'UNKNOWN'}); Medusa capture fact was not recorded.`,
      )
    }
    return {
      data: {
        ...(input.data as object),
        id: externalId,
        capture_id: capture.id,
        status: capture.status,
      },
    }

    })
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const environment = isolation.environmentOf(input.data)
    return isolation.environmentContext.run(environment, async () => {
    const captureId = (input.data?.capture_id as string | undefined) || await this.findCaptureId(input.data?.id as string)
    if (!captureId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'PayPal refund requires a capture id.',
      )
    }
    // Medusa passes the refund amount as `refund.raw_amount`, i.e. a
    // `{ value, precision }` object (a BigNumberInput), NOT a plain number.
    // `Number({ value, precision })` is NaN, which PayPal rejects with
    // INVALID_REQUEST. Coerce through BigNumber so any BigNumberInput shape
    // (raw object, BigNumber instance, string, or number) resolves correctly.
    const amount = new BigNumber(input.amount).numeric.toFixed(2)
    const adoption = externalRefundContext.getStore()
    if (adoption) {
      if (adoption.environment !== environment || adoption.captureId !== captureId || adoption.amount !== amount ||
          adoption.currency !== String(input.data?.currency_code || '').toUpperCase()) {
        throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'External refund context mismatch.')
      }
      const existing = await this.request<PayPalRefund>(
        'GET', `/v2/payments/refunds/${encodeURIComponent(adoption.refundId)}`,
      )
      if (existing.id !== adoption.refundId || existing.status !== 'COMPLETED' ||
          existing.amount?.value !== amount || existing.amount?.currency_code !== adoption.currency) {
        throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'External refund fact changed.')
      }
      return { data: { ...input.data, refund_id: existing.id,
        refund_map: { ...(input.data?.refund_map as object || {}), [existing.id]: input.context?.idempotency_key } } }
    }
    if (!input.context?.idempotency_key) {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, 'PayPal refund requires a Medusa refund id.')
    }
    const refund = await this.request<PayPalRefund>(
      'POST',
      `/v2/payments/captures/${captureId}/refund`,
      { amount: { value: amount, currency_code: (input.data?.currency_code as string) || 'USD' } },
      {
        'PayPal-Request-Id': this.requestId(
          'refund',
          String(input.context.idempotency_key),
        ),
      },
    )
    const refundAmount = new BigNumber(refund.amount?.value as any).numeric.toFixed(2)
    const refundCurrency = refund.amount?.currency_code?.toUpperCase()
    if (refund.status !== 'COMPLETED' || refundAmount !== amount ||
        refundCurrency !== String(input.data?.currency_code || 'USD').toUpperCase()) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'PayPal refund was not completed for the exact requested amount and currency.',
      )
    }
    return {
      data: {
        ...(input.data as object),
        id: input.data?.id,
        refund_id: refund.id,
        refund_map: { ...(input.data?.refund_map as object || {}), [refund.id]: input.context.idempotency_key },
        status: refund.status,
      },
    }

    })
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const environment = isolation.environmentOf(input.data)
    return isolation.environmentContext.run(environment, async () => {
    const externalId = input.data?.id as string | undefined
    if (!externalId || input.data?.capture_id) return { data: input.data }
    // A local authorization transaction error can trigger this compensation
    // after PayPal has already captured. Never void that captured operation.
    // Void an un-captured authorization if one exists.
    const authorizationId = await this.findAuthorizationId(externalId)
    if (authorizationId) {
      try {
        await this.request('POST', `/v2/payments/authorizations/${authorizationId}/void`, {})
      } catch (err) {
        this.logger_.warn(`PayPal void failed for ${authorizationId}: ${(err as Error).message}`)
      }
    }
    return { data: input.data }

    })
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    const environment = isolation.environmentOf(input.data)
    return isolation.environmentContext.run(environment, async () => {
    // PayPal has no "delete order" for an un-approved checkout order; nothing to
    // clean up server-side. Return the data unchanged.
    return { data: input.data }

    })
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const environment = isolation.environmentOf(input.data)
    return isolation.environmentContext.run(environment, async () => {
    // The amount is fixed at initiate time for redirect orders; a cart edit
    // re-initiates instead. No-op here.
    return { data: input.data }

    })
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const environment = isolation.environmentOf(input.data)
    return isolation.environmentContext.run(environment, async () => {
    const externalId = input.data?.id as string | undefined
    if (!externalId) return { data: input.data }
    const order = await this.request<PayPalOrder>('GET', `/v2/checkout/orders/${externalId}`)
    const expected = this.expectedPayment(input.data as Record<string, unknown>, order)
    const capture = this.captureFromOrder(order, expected)
    const authorization = order.purchase_units?.flatMap((unit) => unit.payments?.authorizations || [])[0]
    let status = order.status === 'APPROVED' ? 'APPROVED' : 'PENDING'
    if (capture?.status === 'COMPLETED') status = 'CAPTURED'
    else if (capture?.status === 'PENDING') status = 'PENDING_CAPTURE'
    else if (capture) status = capture.status
    else if (authorization?.status === 'CREATED') status = 'AUTHORIZED'
    else if (authorization) status = authorization.status
    return { data: { ...(input.data as object), status } }

    })
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const environment = isolation.environmentOf(input.data)
    return isolation.environmentContext.run(environment, async () => {
    const status = input.data?.status as string | undefined
    switch (status) {
      case 'AUTHORIZED':
        return { status: 'authorized' }
      case 'CAPTURED':
        return { status: 'captured' }
      case 'PENDING_CAPTURE':
        return { status: 'pending_authorization' }
      case 'VOIDED':
      case 'CANCELED':
        return { status: 'canceled' }
      case 'FAILED':
        return { status: 'error' }
      default:
        return { status: 'pending' }
    }

    })
  }

  // --- Webhook -------------------------------------------------------------

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload['payload'],
  ): Promise<WebhookActionResult> {
    const { data } = payload
    const event = data as unknown as PayPalWebhookEvent
    const eventType = event.event_type
    const resource = event.resource
    const sessionId = this.resolveSessionId(resource)

    // A PayPal event we cannot tie back to a Medusa payment session must never
    // resolve to an arbitrary session/cart, so we return a not_supported action
    // with an empty session id; the framework ignores such events.
    const noSession = { action: 'not_supported', data: { session_id: '', amount: 0 } } as WebhookActionResult

    // Signature verification is the gate that separates a real PayPal event
    // from a forged one. Medusa's built-in webhook route forwards the raw body
    // and headers without verifying anything, so any host that can reach
    // /hooks/payment/paypal could otherwise POST a fabricated
    // CHECKOUT.ORDER.APPROVED and drive a cart to completion. We ask PayPal to
    // verify the transmission before acting on ANY event; a failure or a
    // missing header set is treated exactly like an unmatchable session.
    const verified = await this.verifyWebhookSignature(payload)
    if (!verified) {
      this.logger_.warn('PayPal webhook rejected: signature verification failed.')
      return noSession
    }

    return isolation.environmentContext.run(verified, async () => {
    switch (eventType) {
      case WEBHOOK_EVENTS.APPROVED:
        // Buyer approved on PayPal. Authorize the session → completes the cart.
        return sessionId
          ? { action: 'authorized', data: { session_id: sessionId, amount: 0, paypal_environment: verified } as any }
          : noSession
      case WEBHOOK_EVENTS.COMPLETED: {
        // Re-read the provider order instead of treating a signed notification
        // as proof of a complete capture. Partial/mismatched facts fail closed.
        const orderId = (resource as any)?.supplementary_data?.related_ids?.order_id
        if (!sessionId || typeof orderId !== 'string') return noSession
        const order = await this.request<PayPalOrder>(
          'GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
        )
        if (order.id !== orderId || this.resolveSessionId(order) !== sessionId) return noSession
        const expected = this.expectedPayment({}, order)
        const captures = order.purchase_units?.flatMap((unit) => unit.payments?.captures || []) || []
        // A delayed COMPLETED event must not undo a later provider refund or
        // perpetually retry capture. Validate the original capture relationship
        // and ignore the obsolete action; reconciliation owns the refund facts.
        if (captures.length === 1 && captures[0].id === resource.id &&
            ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(captures[0].status)) {
          this.assertExactCapture(captures[0], expected)
          return noSession
        }
        const capture = this.captureFromOrder(order, expected)
        if (!capture || capture.status !== 'COMPLETED' || capture.id !== resource.id) return noSession
        return { action: 'captured', data: { session_id: sessionId, amount: this.webhookAmount(capture), paypal_environment: verified } as any }
      }
      case WEBHOOK_EVENTS.DENIED:
        return sessionId
          ? { action: 'failed', data: { session_id: sessionId, amount: 0, paypal_environment: verified } as any }
          : noSession
      case WEBHOOK_EVENTS.REFUNDED:
      case WEBHOOK_EVENTS.REVERSED:
        // The PawShop reconciliation middleware handles these with a durable
        // ledger and the official refund workflow; never re-trigger checkout.
        return noSession
      default:
        return noSession
    }
    })
  }

  private webhookAmount(resource: any): number {
    const value = resource?.amount?.value
    const amount = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
    return Number.isFinite(amount) && amount > 0 ? amount : 0
  }

  private resolveSessionId(resource: any): string {
    // We stored the Medusa payment session id in the PayPal order's `custom_id`
    // (purchase_units[0].custom_id) at initiate time. CHECKOUT.ORDER.APPROVED
    // carries the full order; PAYMENT.CAPTURE.* events carry a capture whose
    // `custom_id` PayPal also copies from the purchase unit when present.
    const candidates = [
      resource?.purchase_units?.[0]?.custom_id,
      resource?.custom_id,
      resource?.supplementary_data?.related_ids?.custom_id,
    ]
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  // Verifies a PayPal webhook transmission against PayPal's own signature
  // service. PayPal signs each webhook with a transmission-id, timestamp, the
  // webhook-id, and a signature over that material plus the raw event body,
  // and publishes the verification certificate at PAYPAL-CERT-URL. Rather than
  // reimplement the cert fetch and RSA verification (and its pinning/rotation
  // hazards), we ask PayPal to verify the transmission server-to-server: this
  // returns VERIFICATION_STATUS=SUCCESS only for an authentic, unmodified event.
  private async verifyWebhookSignature(payload: ProviderWebhookPayload['payload']): Promise<string | null> {
    let raw: any = payload.rawData
    if (raw?.type === 'Buffer' && Array.isArray(raw.data)) raw = Buffer.from(raw.data)
    try {
      if (!raw || JSON.stringify(JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw)) !== JSON.stringify(payload.data)) return null
      return await isolation.verifyDual(payload.headers, raw, this.contract_)
    } catch { return null }
  }

  private async findAuthorizationId(orderId?: string): Promise<string | null> {
    if (!orderId) return null
    const order = await this.request<PayPalOrder>('GET', `/v2/checkout/orders/${orderId}`)
    return order.purchase_units?.[0]?.payments?.authorizations?.[0]?.id ?? null
  }

  private async findCaptureId(orderId?: string): Promise<string | null> {
    if (!orderId) return null
    const order = await this.request<PayPalOrder>('GET', `/v2/checkout/orders/${orderId}`)
    return order.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? null
  }
}

interface PayPalOrder {
  id: string
  status: string
  intent: string
  links?: Array<{ href: string; rel: string; method: string }>
  purchase_units?: Array<{
    custom_id?: string
    amount?: { currency_code?: string; value?: string }
    payments?: {
      authorizations?: Array<{ id: string; status: string }>
      captures?: PayPalCapture[]
    }
  }>
}

interface PayPalCapture {
  id: string
  status: string
  amount?: { currency_code?: string; value?: string }
}

interface PayPalRefund {
  id: string
  status: string
  amount?: { currency_code?: string; value?: string }
}

interface PayPalWebhookEvent {
  event_type: string
  resource: any
}

export default PayPalPaymentProviderService
