import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { refetchEntities } from '@medusajs/framework/http'
import { commerceIsOpen } from '../../../../lib/production-modes.cjs'

// Guest order lookup: order number + email → verified order summary.
//
// This is a deliberate, minimal substitute for a full customer account. A
// buyer can look up an order they just placed without registering, by proving
// they know both the order number (display_id) and the email the order was
// placed with. That two-factor match is the entire access control: without a
// customer session there is no other identity to verify against.
//
// Anti-enumeration: every failure — a malformed query, an order number that
// does not exist, or a mismatched email — returns the same 404 body, so a
// caller cannot distinguish "order exists" from "email is wrong".
//
// This route is only served while the storefront profile is open; when the
// store is closed it 404s like every other customer-facing route.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Public order number format: PS-YYYYMMDD-NNNN, where YYYYMMDD is the order's
// creation date and NNNN is the real Medusa display_id zero-padded to 4 digits.
// It is always derived from real order data on the server — never assembled by
// the client — and is stable for any historical order. It is a cosmetic alias
// for the display_id, not a replacement of the Medusa primary key.
const PUBLIC_PREFIX = 'PS-'
const PUBLIC_PATTERN = /^PS-(\d{8})-(\d+)$/

function buildPublicOrderNumber(displayId: number, createdAt: string): string {
  const d = new Date(createdAt)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${PUBLIC_PREFIX}${yyyy}${mm}${dd}-${String(displayId).padStart(4, '0')}`
}

// Accept every human-typed form of an order number and reduce it to the raw
// Medusa display_id used for the query: "6", "#6", "PS-20260929-0006" all
// resolve to 6. Anything that cannot be reduced to a positive integer is
// invalid and returns the same 404 as every other failure.
function parseOrderNumberInput(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Public order number → extract the display_id portion (rightmost segment).
  const pub = trimmed.match(PUBLIC_PATTERN)
  if (pub) {
    const n = Number(pub[2])
    return Number.isInteger(n) && n > 0 ? n : null
  }

  // "#6" → strip a leading "#" and parse the digits.
  const bare = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  const n = Number(bare)
  return Number.isInteger(n) && n > 0 ? n : null
}

type LookupResponse = {
  order: {
    order_number: number
    public_order_number: string
    status: string
    payment_status: string | null
    fulfillment_status: string | null
    currency_code: string
    total: number
    created_at: string
    email: string
    items: Array<{
      title: string
      quantity: number
      unit_price: number
      total: number
      thumbnail: string | null
    }>
    shipping_method: string | null
    shipping_amount: number | null
    shipping_address: {
      first_name: string | null
      last_name: string | null
      address_1: string | null
      address_2: string | null
      city: string | null
      province: string | null
      postal_code: string | null
      country_code: string | null
    } | null
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  // Closed storefront → the whole customer namespace is unreachable.
  if (!commerceIsOpen(process.env.PAWSHOP_MODE)) {
    return res.status(404).json({ type: 'not_found' })
  }

  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : ''
  if (!EMAIL_PATTERN.test(email)) {
    return res.status(404).json({ type: 'not_found' })
  }

  // Two lookup modes, both gated by the same email:
  //  1. order_number + email — the buyer already has their order number. The
  //     order_number accepts the raw display_id ("6"), the "#6" display form,
  //     or the public order number ("PS-20260929-0006"); all normalize to the
  //     same display_id.
  //  2. cart_id + email — the buyer just returned from PayPal approval and only
  //     has their cart id; the order is resolved through the order_cart link.
  const rawNumber = req.query.order_number
  const rawCartId = req.query.cart_id

  let orderId: string | null = null

  if (rawNumber !== undefined) {
    const orderNumber = parseOrderNumberInput(rawNumber)
    if (orderNumber === null) {
      return res.status(404).json({ type: 'not_found' })
    }
    const byNumber = await refetchEntities({
      entity: 'order',
      idOrFilter: { display_id: orderNumber, email },
      scope: req.scope,
      fields: ['id'],
    })
    orderId = (byNumber.data?.[0] as { id?: string } | undefined)?.id ?? null
  } else if (typeof rawCartId === 'string' && rawCartId.trim()) {
    const link = await refetchEntities({
      entity: 'order_cart',
      idOrFilter: { cart_id: rawCartId.trim() },
      scope: req.scope,
      fields: ['order_id'],
    })
    orderId = (link.data?.[0] as { order_id?: string } | undefined)?.order_id ?? null
  } else {
    return res.status(404).json({ type: 'not_found' })
  }

  if (!orderId) {
    return res.status(404).json({ type: 'not_found' })
  }

  // Re-read the order by id with the email still enforced, so a caller who
  // guesses a cart id cannot read someone else's order without the email.
  const result = await refetchEntities({
    entity: 'order',
    idOrFilter: { id: orderId, email },
    scope: req.scope,
    fields: [
      'id',
      'display_id',
      'status',
      'payment_status',
      'fulfillment_status',
      'currency_code',
      'total',
      'created_at',
      'email',
      'items.title',
      'items.quantity',
      'items.unit_price',
      'items.total',
      'items.thumbnail',
      'shipping_methods.name',
      'shipping_methods.amount',
      'shipping_address.first_name',
      'shipping_address.last_name',
      'shipping_address.address_1',
      'shipping_address.address_2',
      'shipping_address.city',
      'shipping_address.province',
      'shipping_address.postal_code',
      'shipping_address.country_code',
    ],
  })

  const order = result.data?.[0] as unknown as
    | {
        id: string
        display_id: number
        status: string
        payment_status?: string | null
        fulfillment_status?: string | null
        currency_code: string
        total: number
        created_at: string
        email: string
        items?: Array<{
          title: string
          quantity: number
          unit_price: number
          total: number
          thumbnail?: string | null
        }>
        shipping_methods?: Array<{ name?: string | null; amount?: number | null }> | null
        shipping_address?: {
          first_name?: string | null
          last_name?: string | null
          address_1?: string | null
          address_2?: string | null
          city?: string | null
          province?: string | null
          postal_code?: string | null
          country_code?: string | null
        } | null
      }
    | undefined

  // No match (or email mismatch) → the identical 404 as any other failure.
  if (!order) {
    return res.status(404).json({ type: 'not_found' })
  }

  const shippingAddress = order.shipping_address ?? null
  const shippingMethod = (order.shipping_methods || [])[0] ?? null

  const payload: LookupResponse = {
    order: {
      order_number: order.display_id,
      public_order_number: buildPublicOrderNumber(order.display_id, order.created_at),
      status: order.status,
      payment_status: order.payment_status ?? null,
      fulfillment_status: order.fulfillment_status ?? null,
      currency_code: order.currency_code,
      total: Number(order.total),
      created_at: order.created_at,
      email: order.email,
      items: (order.items || []).map((item) => ({
        title: item.title,
        quantity: item.quantity,
        unit_price: Number(item.unit_price),
        total: Number(item.total),
        thumbnail: item.thumbnail ?? null,
      })),
      shipping_method: shippingMethod?.name ?? null,
      shipping_amount: shippingMethod?.amount != null ? Number(shippingMethod.amount) : null,
      shipping_address: shippingAddress
        ? {
            first_name: shippingAddress.first_name ?? null,
            last_name: shippingAddress.last_name ?? null,
            address_1: shippingAddress.address_1 ?? null,
            address_2: shippingAddress.address_2 ?? null,
            city: shippingAddress.city ?? null,
            province: shippingAddress.province ?? null,
            postal_code: shippingAddress.postal_code ?? null,
            country_code: shippingAddress.country_code ?? null,
          }
        : null,
    },
  }

  return res.status(200).json(payload)
}
