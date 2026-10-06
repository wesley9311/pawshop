import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { refetchEntities } from '@medusajs/framework/http'
import { getOrderDetailWorkflow } from '@medusajs/core-flows'
import { commerceIsOpen } from '../../../../lib/production-modes.cjs'
import {
  ORDER_DETAIL_FIELDS,
  LOOKUP_NOT_FOUND_BODY,
  LOOKUP_NOT_FOUND_STATUS,
  LOOKUP_SERVICE_UNAVAILABLE_BODY,
  LOOKUP_SERVICE_UNAVAILABLE_STATUS,
  isLookupEmail,
  parseOrderNumberInput,
  serializeOrderDetail,
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
// What remains here is I/O: resolve the order, then serialize through
// `serializeOrderDetail` (the shared wire shape used by both the guest lookup
// and the authenticated account order detail).

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
  //
  // A thrown error here is a *system* failure (a backend error, a database
  // that did not answer, a 500/502/503 upstream) — not "no such order". It
  // must therefore map to the distinct `service_unavailable` response, never
  // to the 404, so the storefront can say "temporarily unavailable" instead
  // of "order not found". The raw error is deliberately swallowed: nothing of
  // it reaches the wire.
  let orderDetail: unknown;
  try {
    const result = await getOrderDetailWorkflow(req.scope).run({
      input: {
        order_id: orderId,
        filters: { is_draft_order: false },
        fields: ORDER_DETAIL_FIELDS,
      },
    });
    orderDetail = result.result;
  } catch (_error) {
    return res.status(LOOKUP_SERVICE_UNAVAILABLE_STATUS).json(LOOKUP_SERVICE_UNAVAILABLE_BODY)
  }

  // No match (or email mismatch) → the identical 404 as any other failure.
  if (!orderDetail) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  // Serialize through the shared helper so the guest lookup and the
  // authenticated account order detail emit the exact same wire shape (the
  // `order` object the storefront renders). The helper narrows the workflow's
  // `OrderDetailDTO` and maps fulfilments (dropping `label_url` and the
  // internal `fulfillment.id`) — see `lib/order-lookup.cjs`.
  const payload = serializeOrderDetail(orderDetail)
  if (!payload) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  return res.status(200).json(payload)
}
