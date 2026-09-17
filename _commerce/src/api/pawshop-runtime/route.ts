import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { commerceIsOpen, isProductionMode } from '../../lib/production-modes.cjs'

const loopbackClients = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const mode = process.env.PAWSHOP_MODE
  if (
    process.env.NODE_ENV !== 'production' ||
    !isProductionMode(mode) ||
    !loopbackClients.has(req.socket.remoteAddress || '')
  ) {
    return res.status(404).json({ type: 'not_found' })
  }
  return res.status(200).json({
    mode,
    topology: process.env.PAWSHOP_INFRA_TOPOLOGY,
    commerce: commerceIsOpen(mode) ? 'open' : 'closed',
  })
}
