import { defineMiddlewares, authenticate } from '@medusajs/framework/http'
import { commerceIsOpen } from '../lib/production-modes.cjs'
import { validateCartShippingAddress } from '../lib/address-structure.cjs'
import { verificationRateLimit } from '../lib/verification-rate-limit-middleware.cjs'
import { normalizeAuthEmail } from '../lib/normalize-auth-email.cjs'

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
    // Customer registration override (`src/api/store/customers/route.ts`) replaces
    // the stock route handler with the guest-claim path. The stock middleware
    // already authenticates the same way, but re-declaring it here makes the
    // override self-contained and keeps the actorless-registration token accepted
    // (allowUnregistered) while an already-authenticated customer is rejected by
    // the route itself.
    ...(commerceOpen
      ? [
          {
            matcher: '/store/customers',
            method: 'POST' as const,
            middlewares: [authenticate('customer', ['session', 'bearer'], { allowUnregistered: true })],
          },
          {
            matcher: '/store/customers/me/security',
            middlewares: [authenticate('customer', ['bearer'])],
          },
          // Canonicalize the email before it reaches emailpass register/login and
          // before any lookup. This is the single choke point that keeps register /
          // login / verification / lookup / claim on one address form.
          {
            matcher: '/auth/:actor_type/:auth_provider/register',
            method: 'POST' as const,
            middlewares: [normalizeAuthEmail],
          },
          {
            matcher: '/auth/:actor_type/:auth_provider',
            method: 'POST' as const,
            middlewares: [normalizeAuthEmail],
          },
          // Verification-code request rate limiting (60s cooldown, 5/hour per
          // email, 20/hour per IP). Only the request route; confirm is unlimited
          // (a wrong code simply fails the confirm). Normalization runs first so
          // the rate-limit key and the delivered code agree on the same address.
          {
            matcher: '/auth/verification/request',
            method: 'POST' as const,
            middlewares: [normalizeAuthEmail, verificationRateLimit],
          },
        ]
      : []),
    { matcher: '/connector/v1', ...connectorBodyParser },
    { matcher: '/connector/v1/*', ...connectorBodyParser },
  ],
})
