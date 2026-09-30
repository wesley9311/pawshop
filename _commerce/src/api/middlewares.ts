import { defineMiddlewares } from '@medusajs/framework/http'
import { commerceIsOpen } from '../lib/production-modes.cjs'
import { validateCartShippingAddress } from '../lib/address-structure.cjs'

const unavailable = (_req: any, res: any) => {
  res.status(503).json({ type: 'not_allowed', message: 'PawShop storefront APIs are not open.' })
}

// Customer commerce stays shut unless the deployment explicitly runs in the
// storefront profile. commerceIsOpen(undefined) is false, so a missing or
// mistyped mode keeps these routes closed instead of opening them.
//
// The store namespace is closed twice over, but only one of the two is reachable
// per request. Medusa's HTTP loader installs its own store API-key gate directly
// on the app before any user middleware or route, so a request without a key is
// refused up there and never reaches `unavailable`. These matchers still matter:
// they close the namespace for any request that does present a key, which is what
// keeps store data unreadable while the admin-only profile is active.
const commerceOpen = commerceIsOpen(process.env.PAWSHOP_MODE)

// The connector's request signature is an HMAC over the SHA-256 of the body as
// transmitted, so the raw bytes have to survive parsing. `preserveRawBody` makes
// Medusa's JSON parser stash the untouched buffer on `req.rawBody`; without it
// the signature could only be checked against a re-serialised body, which is not
// the same bytes. The connector is its own namespaced route tree and is never
// gated by the storefront profile above.
const connectorBodyParser = {
  bodyParser: { preserveRawBody: true, sizeLimit: '1mb' },
  middlewares: [],
}

// Shipping-address structure validation (A11). Medusa's cart address schema
// marks every field optional, so the server accepts an incomplete US address.
// These two routes are the only way the storefront stores an address, so
// gating them is both the smallest correct insertion point and a real final
// line of defence: nothing downstream (shipping method, payment collection,
// PayPal approval) can run against an address that was never written.
//
// Registered only in the storefront profile — the closed profile answers 503
// for /store before any of this matters, and this must not change that.
const cartAddressValidation = commerceOpen
  ? [
      { matcher: '/store/carts', method: 'POST' as const, middlewares: [validateCartShippingAddress] },
      { matcher: '/store/carts/:id', method: 'POST' as const, middlewares: [validateCartShippingAddress] },
    ]
  : []

export default defineMiddlewares({
  routes: [
    ...(commerceOpen
      ? []
      : [
          { matcher: '/store', middlewares: [unavailable] },
          { matcher: '/store/*', middlewares: [unavailable] },
          { matcher: '/auth/customer', middlewares: [unavailable] },
          { matcher: '/auth/customer/*', middlewares: [unavailable] },
        ]),
    ...cartAddressValidation,
    { matcher: '/connector/v1', ...connectorBodyParser },
    { matcher: '/connector/v1/*', ...connectorBodyParser },
  ],
})
