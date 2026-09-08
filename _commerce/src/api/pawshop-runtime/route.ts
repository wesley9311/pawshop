import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'

const loopbackClients = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (
    process.env.NODE_ENV !== 'production' ||
    process.env.PAWSHOP_MODE !== 'production-admin-only' ||
    !loopbackClients.has(req.socket.remoteAddress || '')
  ) {
    return res.status(404).json({ type: 'not_found' })
  }
  return res.status(200).json({
    mode: 'production-admin-only',
    topology: process.env.PAWSHOP_INFRA_TOPOLOGY,
    commerce: 'closed',
  })
}
