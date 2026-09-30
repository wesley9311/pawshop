import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { refetchEntities } from '@medusajs/framework/http'
import { getOrderDetailWorkflow } from '@medusajs/core-flows'
import { commerceIsOpen } from '../../../../lib/production-modes.cjs'
import {
  LOOKUP_FULFILLMENT_FIELDS,
  LOOKUP_NOT_FOUND_BODY,
  LOOKUP_NOT_FOUND_STATUS,
  buildPublicOrderNumber,
  isLookupEmail,
  mapFulfillments,
  parseOrderNumberInput,
} from '../../../../lib/order-lookup.cjs'

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
//
// All pure logic — order-number parsing, email validation, the fulfilment wire
// shape — lives in `lib/order-lookup.cjs` so it can be unit-tested directly.
// What remains here is I/O: resolve the order, then serialize.

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
    // Every fulfillment that belongs to this order, as an array: an order can
    // be fulfilled in several shipments, so the client must never assume one
    // package or one tracking number. Timestamps are the real `fulfillment`
    // columns; the client derives each package's state from them and shows
    // nothing it was not given.
    fulfillments: Array<{
      id: string
      created_at: string | null
      packed_at: string | null
      shipped_at: string | null
      delivered_at: string | null
      canceled_at: string | null
      labels: Array<{
        tracking_number: string | null
        tracking_url: string | null
      }>
    }>
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  // Closed storefront → the whole customer namespace is unreachable.
  if (!commerceIsOpen(process.env.PAWSHOP_MODE)) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : ''
  if (!isLookupEmail(email)) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
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
      return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
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
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  if (!orderId) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  // Re-verify the email against the resolved order id. This is the second half
  // of the anti-enumeration gate and matters especially for the cart_id branch
  // above, which resolves an order id from the order_cart link without touching
  // email. A caller who guesses a cart id must still know the order's email, or
  // this lookup is rejected with the same 404 as every other failure.
  const emailGate = await refetchEntities({
    entity: 'order',
    idOrFilter: { id: orderId, email },
    scope: req.scope,
    fields: ['id'],
  })
  if (!emailGate.data?.[0]) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  // Read the order through Medusa's official get-order-detail workflow. What
  // changes here is the *source* of payment_status / fulfillment_status:
  // those are not stored columns on the `order` entity — they are computed on
  // `OrderDetail` by aggregating `payment_collections` and `fulfillments`. The
  // official workflow runs exactly that aggregation, so we reuse it instead of
  // re-deriving the status in this route (which would risk drifting from
  // Medusa's own semantics).
  const { result: orderDetail } = await getOrderDetailWorkflow(req.scope).run({
    input: {
      order_id: orderId,
      filters: { is_draft_order: false },
      fields: [
        'id',
        'display_id',
        'status',
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
        // Fulfillment / shipment timeline (Phase 1 logistics). The whitelist is
        // owned by `lib/order-lookup.cjs`: every entry is a real Medusa column
        // on `fulfillment` / `fulfillment_label`, nothing derived or invented.
        // `getOrderDetailWorkflow` already appends `fulfillments.*`, so these
        // only add the nested `labels` relation that carries the tracking
        // numbers. `labels.label_url` is absent by construction — it is the
        // warehouse's shipping-label artifact, not buyer-visible data.
        ...LOOKUP_FULFILLMENT_FIELDS,
      ],
    },
  })

  // No match (or email mismatch) → the identical 404 as any other failure.
  if (!orderDetail) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  // Narrow the workflow's `OrderDetailDTO` down to the exact shape this route
  // serializes. `payment_status` / `fulfillment_status` arrive as Medusa's own
  // aggregated strings; the numeric/date fields arrive as JSON-serialized
  // primitives from the query graph.
  const order = orderDetail as unknown as {
    id: string
    display_id: number
    status: string
    payment_status: string
    fulfillment_status: string
    currency_code: string
    total: number | string
    created_at: string
    email: string
    items: Array<{
      title: string
      quantity: number
      unit_price: number
      total: number | string
      thumbnail: string | null
    }>
    shipping_methods: Array<{ name: string | null; amount: number | null }> | null
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
    fulfillments: Array<{
      id: string
      created_at: string | null
      packed_at: string | null
      shipped_at: string | null
      delivered_at: string | null
      canceled_at: string | null
      labels: Array<{ tracking_number: string | null; tracking_url: string | null }> | null
    }> | null
  }

  const shippingAddress = order.shipping_address ?? null
  const shippingMethod = (order.shipping_methods || [])[0] ?? null

  // Fulfillments are ordered oldest-first so the client can list the packages
  // in the order they were created. Only the real columns cross the wire: a
  // fulfillment with no labels simply carries an empty `labels` array, and the
  // client shows the timeline without a tracking number rather than inventing
  // one. `label_url` never leaves the server.
  const fulfillments = mapFulfillments(order.fulfillments)

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
      fulfillments,
    },
  }

  return res.status(200).json(payload)
}
