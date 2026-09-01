import { defineMiddlewares } from '@medusajs/framework/http'

const unavailable = (_req: any, res: any) => {
  res.status(503).json({ type: 'not_allowed', message: 'PawShop storefront APIs are not open.' })
}

export default defineMiddlewares({
  routes: [
    { matcher: '/store', middlewares: [unavailable] },
    { matcher: '/store/*', middlewares: [unavailable] },
    { matcher: '/auth/customer', middlewares: [unavailable] },
    { matcher: '/auth/customer/*', middlewares: [unavailable] },
  ],
})
