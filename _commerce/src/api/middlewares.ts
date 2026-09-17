import { defineMiddlewares } from '@medusajs/framework/http'
import { commerceIsOpen } from '../lib/production-modes.cjs'

const unavailable = (_req: any, res: any) => {
  res.status(503).json({ type: 'not_allowed', message: 'PawShop storefront APIs are not open.' })
}

// Customer commerce stays shut unless the deployment explicitly runs in the
// storefront profile. commerceIsOpen(undefined) is false, so a missing or
// mistyped mode keeps these routes closed instead of opening them.
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
