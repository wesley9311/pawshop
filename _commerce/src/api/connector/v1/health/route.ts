import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ConnectorRequestError, connectorErrorStatus } from '../../../../lib/connector-errors.cjs'
import {
  authenticateConnectorRequest,
  connectorNotFound,
  recordConnectorAudit,
  sendConnectorError,
  sendConnectorJson,
} from '../../../../lib/connector-http'

// GET /api/connector/v1/health
//
// Authenticated like every other connector route: health is a credential probe,
// not a public endpoint. The response echoes the key id and version that were
// accepted and nothing else — no token, no secret, no fingerprint of either — so
// a caller can confirm a rotation took effect without PawShop disclosing
// anything reusable.

function errorCodeOf(error: unknown): string {
  return error instanceof ConnectorRequestError ? error.code : 'INTERNAL_ERROR'
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const startedAt = Date.now()
  try {
    const principal = await authenticateConnectorRequest(req, 'connector:health:read')
    await recordConnectorAudit(req, {
      keyId: principal.keyId,
      keyVersion: principal.keyVersion,
      outcome: 'read',
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
    })
    return sendConnectorJson(res, 200, {
      status: 'ok',
      connector: 'pawshop',
      version: 'v1',
      authenticatedKeyId: principal.keyId,
      authenticatedKeyVersion: principal.keyVersion,
    })
  } catch (error) {
    const status = connectorErrorStatus(error)
    await recordConnectorAudit(req, {
      outcome: 'rejected',
      httpStatus: status,
      errorCode: errorCodeOf(error),
      durationMs: Date.now() - startedAt,
    })
    return sendConnectorError(res, error)
  }
}

// Any other verb on this path is an unmatched route, exactly as the reference
// implementation answers it.
export const POST = connectorNotFound
export const PUT = connectorNotFound
export const PATCH = connectorNotFound
export const DELETE = connectorNotFound
