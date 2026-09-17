import { defineMiddlewares } from '@medusajs/framework/http'
import { commerceIsOpen } from '../lib/production-modes.cjs'

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

export default defineMiddlewares({
  routes: commerceOpen
    ? []
    : [
        { matcher: '/store', middlewares: [unavailable] },
        { matcher: '/store/*', middlewares: [unavailable] },
        { matcher: '/auth/customer', middlewares: [unavailable] },
        { matcher: '/auth/customer/*', middlewares: [unavailable] },
      ],
})
