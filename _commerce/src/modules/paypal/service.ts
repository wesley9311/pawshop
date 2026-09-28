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

// PayPal Orders API v2 — redirect (authorize/capture) integration.
//
// This provider deliberately implements the *redirect* flow: initiatePayment
// creates a PayPal order whose `intent` is AUTHORIZE and returns an approval
// URL (in `data.approval_url`) that the storefront opens in a new tab. The
// buyer approves on PayPal, PayPal redirects back to the storefront's return
// URL, and then either the webhook (CHECKOUT.ORDER.APPROVED → authorized) or
// the storefront's completion request authorizes the order inside Medusa.
// Capturing is a separate, explicit step (capturePayment) so funds are only
// taken once the order is confirmed, never on authorization alone.

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
    this.apiBase_ = options.sandbox ? API_BASE.sandbox : API_BASE.live
    this.approvalBase_ = options.sandbox ? APPROVAL_BASE.sandbox : APPROVAL_BASE.live
  }

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

  private async accessToken(): Promise<string> {
    if (this.token_ && this.token_.expiresAt > Date.now() + 60_000) {
      return this.token_.value
    }
    const res = await fetch(`${this.apiBase_}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(
          `${this.options_.client_id}:${this.options_.client_secret}`,
        ).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    })
    if (!res.ok) {
      const body = await res.text()
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `PayPal OAuth failed (${res.status}).`,
      )
    }
    const json = (await res.json()) as { access_token: string; expires_in: number }
    this.token_ = {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    }
    return this.token_.value
  }

  private async request<T = any>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.accessToken()
    const res = await fetch(`${this.apiBase_}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!res.ok) {
      const name = json?.name || `HTTP ${res.status}`
      const detail = json?.message || json?.details?.[0]?.description || text
      this.logger_.error(`PayPal ${method} ${path} failed: ${name} — ${detail}`)
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `PayPal ${method} ${path} failed (${name}).`,
      )
    }
    return json as T
  }

  // --- Lifecycle methods ---------------------------------------------------

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
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
      },
    }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
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

    if (order.status === 'APPROVED') {
      // First approval: perform the authorization and read back the new
      // authorization id. The response is the updated order (status COMPLETED).
      order = await this.request<PayPalOrder>(
        'POST',
        `/v2/checkout/orders/${externalId}/authorize`,
        {},
      )
    }

    if (order.status === 'COMPLETED') {
      const authorization = order.purchase_units?.[0]?.payments?.authorizations?.[0]
      const authorizationId = authorization?.id ?? await this.findAuthorizationId(externalId)
      return {
        status: 'authorized',
        data: {
          id: externalId,
          status: order.status,
          authorization_id: authorizationId,
        },
      }
    }

    // The buyer has not approved yet (or canceled). This is not an error from
    // Medusa's perspective — the payment stays pending until the webhook or a
    // later authorize attempt observes approval.
    return {
      status: 'pending',
      data: {
        id: externalId,
        status: order.status,
      },
    }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    const externalId = input.data?.id as string | undefined
    const authorizationId =
      (input.data?.authorization_id as string | undefined) ||
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
    )
    return {
      data: {
        id: externalId,
        capture_id: capture.id,
        status: capture.status,
      },
    }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
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
    const refund = await this.request<PayPalRefund>(
      'POST',
      `/v2/payments/captures/${captureId}/refund`,
      { amount: { value: amount, currency_code: (input.data?.currency_code as string) || 'USD' } },
    )
    return {
      data: {
        id: input.data?.id,
        refund_id: refund.id,
        status: refund.status,
      },
    }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const externalId = input.data?.id as string | undefined
    if (!externalId) return { data: input.data }
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
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    // PayPal has no "delete order" for an un-approved checkout order; nothing to
    // clean up server-side. Return the data unchanged.
    return { data: input.data }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    // The amount is fixed at initiate time for redirect orders; a cart edit
    // re-initiates instead. No-op here.
    return { data: input.data }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const externalId = input.data?.id as string | undefined
    if (!externalId) return { data: input.data }
    const order = await this.request<PayPalOrder>('GET', `/v2/checkout/orders/${externalId}`)
    return { data: { ...(input.data as object), status: order.status } }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const status = input.data?.status as string | undefined
    switch (status) {
      case 'APPROVED':
        return { status: 'authorized' }
      case 'COMPLETED':
        return { status: 'captured' }
      case 'VOIDED':
      case 'CANCELED':
        return { status: 'canceled' }
      case 'FAILED':
        return { status: 'error' }
      default:
        return { status: 'pending' }
    }
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

    switch (eventType) {
      case WEBHOOK_EVENTS.APPROVED:
        // Buyer approved on PayPal. Authorize the session → completes the cart.
        return sessionId
          ? { action: 'authorized', data: { session_id: sessionId, amount: 0 } }
          : noSession
      case WEBHOOK_EVENTS.COMPLETED:
        // A capture completed (either our explicit capture or a direct capture).
        return sessionId
          ? { action: 'captured', data: { session_id: sessionId, amount: 0 } }
          : noSession
      case WEBHOOK_EVENTS.DENIED:
        return sessionId
          ? { action: 'failed', data: { session_id: sessionId, amount: 0 } }
          : noSession
      case WEBHOOK_EVENTS.REFUNDED:
      case WEBHOOK_EVENTS.REVERSED:
        // Refunds are driven from Medusa (refundPayment), not reconciled from
        // PayPal, so these are informational and must not re-trigger completion.
        return noSession
      default:
        return noSession
    }
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
  private async verifyWebhookSignature(
    payload: ProviderWebhookPayload['payload'],
  ): Promise<boolean> {
    const headers = payload.headers || {}
    const header = (name: string) => {
      // HTTP header names are case-insensitive; the framework may normalise or
      // pass them through verbatim, so match case-insensitively.
      const lower = name.toLowerCase()
      for (const key of Object.keys(headers)) {
        if (String(key).toLowerCase() === lower) {
          const value = (headers as Record<string, unknown>)[key]
          if (typeof value === 'string') return value
          if (Array.isArray(value)) return String(value[0] ?? '')
        }
      }
      return ''
    }

    const transmissionId = header('paypal-transmission-id')
    const transmissionTime = header('paypal-transmission-time')
    const transmissionSig = header('paypal-transmission-sig')
    const certUrl = header('paypal-cert-url')
    const authAlgo = header('paypal-auth-algo')

    // Any missing header means the request is not a signed PayPal webhook.
    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
      return false
    }

    // The event body must be the raw bytes PayPal signed; `rawData` is the
    // verbatim request body. If it is missing we cannot verify and must reject.
    const rawBody = payload.rawData as unknown
    let eventBody = ''
    if (typeof rawBody === 'string') {
      eventBody = rawBody
    } else if (Buffer.isBuffer(rawBody)) {
      eventBody = rawBody.toString('utf8')
    } else if (rawBody && typeof rawBody === 'object') {
      // The event bus may serialize a Buffer to { type: 'Buffer', data: [...] }
      // before the subscriber restores it; recover it defensively.
      const serialized = rawBody as { type?: string; data?: number[] }
      if (serialized.type === 'Buffer' && Array.isArray(serialized.data)) {
        eventBody = Buffer.from(serialized.data).toString('utf8')
      }
    }
    if (!eventBody) return false

    try {
      const result = await this.request<{ verification_status?: string }>(
        'POST',
        '/v1/notifications/verify-webhook-signature',
        {
          auth_algo: authAlgo,
          cert_url: certUrl,
          transmission_id: transmissionId,
          transmission_sig: transmissionSig,
          transmission_time: transmissionTime,
          webhook_id: this.options_.webhook_id,
          webhook_event: JSON.parse(eventBody),
        },
      )
      return result.verification_status === 'SUCCESS'
    } catch (err) {
      this.logger_.warn(`PayPal webhook signature verification failed: ${(err as Error).message}`)
      return false
    }
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
    payments?: {
      authorizations?: Array<{ id: string; status: string }>
      captures?: Array<{ id: string; status: string }>
    }
  }>
}

interface PayPalCapture {
  id: string
  status: string
}

interface PayPalRefund {
  id: string
  status: string
}

interface PayPalWebhookEvent {
  event_type: string
  resource: any
}

export default PayPalPaymentProviderService
