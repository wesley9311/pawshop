import type { MedusaStoreRequest, MedusaResponse } from '@medusajs/framework/http'
import { refetchEntities } from '@medusajs/framework/http'
import { getOrderDetailWorkflow } from '@medusajs/core-flows'
import { commerceIsOpen } from '../../../../lib/production-modes.cjs'
import {
  ORDER_DETAIL_FIELDS,
  LOOKUP_NOT_FOUND_BODY,
  LOOKUP_NOT_FOUND_STATUS,
  LOOKUP_SERVICE_UNAVAILABLE_BODY,
  LOOKUP_SERVICE_UNAVAILABLE_STATUS,
  serializeOrderDetail,
} from '../../../../lib/order-lookup.cjs'

// Authenticated order detail: Bearer JWT (customer) + order id → the order, but
// ONLY when the order belongs to the authenticated customer.
//
// This is the account counterpart to the guest `pawshop-orders/lookup` (which
// proves identity with the order_number + email pair). Here the identity is the
// customer JWT itself — `req.auth_context.actor_id` is the customer id — so the
// access control is strict ownership:
//
//   - not authenticated           → 401 (there is no customer to compare against)
//   - authenticated, own order    → 200 with the shared serialized shape
//   - authenticated, other's order → 404 (indistinguishable from "no such order",
//     so a caller cannot probe whether some other customer's order id exists)
//
// The wire shape is the SAME `serializeOrderDetail` the guest lookup emits, so
// the storefront renders an account order detail and a guest order detail with
// one code path. Ownership is enforced by a lightweight `refetchEntities` on
// `id + customer_id` BEFORE the detail workflow runs, so `customer_id` never
// needs to be serialized out (and a nonexistent/foreign order is a 404, not a
// workflow "key not found" 5xx).
//
// Medusa's stock `GET /store/orders/:id` is intentionally UNAUTHENTICATED (it
// leans on the UUID being unguessable). That is not "only my own orders" — it is
// "anyone who holds the id". This route is the deliberate substitute that makes
// ownership an explicit server-enforced rule rather than a guess-hard assumption.

export async function GET(req: MedusaStoreRequest, res: MedusaResponse) {
  // Closed storefront → the whole customer namespace is unreachable, same as the
  // guest lookup (404, not 401, so a closed store never hints at auth semantics).
  if (!commerceIsOpen(process.env.PAWSHOP_MODE)) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  // The auth context is populated by Medusa's authenticate middleware. With the
  // store namespace's allowUnauthenticated default, an anonymous request reaches
  // here with no auth_context (or no actor); that must be a 401 (this is the
  // account-only path), distinct from the guest lookup which is public by design.
  const authContext = req.auth_context
  const customerId = authContext?.actor_id
  if (!customerId || authContext?.actor_type !== 'customer') {
    return res.status(401).json({ type: 'unauthorized', message: 'Authentication required.' })
  }

  const orderId = req.params.id
  if (!orderId || typeof orderId !== 'string') {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  // Existence + ownership in ONE lightweight lookup, BEFORE the heavy detail
  // workflow. `getOrderDetailWorkflow` runs with `throwIfKeyNotFound: true`, so
  // a nonexistent order id would throw and look like a 5xx — which would break
  // the anti-enumeration contract (a miss must be a 404, indistinguishable from
  // "that order is not yours"). Resolving `id + customer_id` here lets every
  // miss — nonexistent, draft, or another customer's — collapse into the same
  // 404 before we ever run the workflow.
  const owned = await refetchEntities({
    entity: 'order',
    idOrFilter: { id: orderId, customer_id: customerId, is_draft_order: false },
    scope: req.scope,
    fields: ['id'],
  })
  if (!owned.data?.[0]) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  // Read the order through Medusa's official get-order-detail workflow. At this
  // point the order is known to exist and to belong to the authenticated
  // customer, so the workflow cannot miss.
  let orderDetail: unknown
  try {
    const result = await getOrderDetailWorkflow(req.scope).run({
      input: {
        order_id: orderId,
        filters: { is_draft_order: false },
        fields: ORDER_DETAIL_FIELDS,
      },
    })
    orderDetail = result.result
  } catch (_error) {
    // A thrown error here is now genuinely a *system* failure (backend error, DB
    // did not answer, 500/502/503) — the existence/ownership was already proven
    // above. It maps to service_unavailable; the raw error never reaches the wire.
    return res.status(LOOKUP_SERVICE_UNAVAILABLE_STATUS).json(LOOKUP_SERVICE_UNAVAILABLE_BODY)
  }

  if (!orderDetail) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  const payload = serializeOrderDetail(orderDetail)
  if (!payload) {
    return res.status(LOOKUP_NOT_FOUND_STATUS).json(LOOKUP_NOT_FOUND_BODY)
  }

  return res.status(200).json(payload)
}
