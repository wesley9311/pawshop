import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { bodySha256 } from '../../../../../lib/connector-auth.cjs'
import { ConnectorRequestError, connectorErrorStatus } from '../../../../../lib/connector-errors.cjs'
import {
  authenticateConnectorRequest,
  connectorHeader,
  connectorNotFound,
  connectorService,
  rawBodyOf,
  recordConnectorAudit,
  sendConnectorError,
  sendConnectorJson,
} from '../../../../../lib/connector-http'
import { externalVersionFor, parseProductUpsertRequest } from '../../../../../lib/connector-payload.cjs'
import { upsertConnectorProduct } from '../../../../../lib/connector-product-writer'

// PUT /api/connector/v1/products/{sourceProductId}
//
// The order of the steps below is not incidental — it is the reference
// implementation's order, and it decides which error a caller sees when more
// than one thing is wrong:
//
//   1. authenticate      headers -> timestamp -> credential -> scope -> signature -> replay
//   2. require Idempotency-Key
//   3. claim the key     before any commerce write, so a concurrent duplicate
//                        cannot create a second product
//   4. answer a replay   with the stored response, before re-validating anything
//   5. validate the DTO
//   6. write, then complete the claim and audit
//
// A failure at any step releases the claim (so the caller's one legitimate retry
// is not refused as in-flight) and writes a rejected/error audit row.

function errorCodeOf(error: unknown): string {
  return error instanceof ConnectorRequestError ? error.code : 'INTERNAL_ERROR'
}

export async function PUT(req: MedusaRequest, res: MedusaResponse) {
  const startedAt = Date.now()
  const service = connectorService(req)
  const rawBody = rawBodyOf(req)
  const requestBodySha256 = bodySha256(rawBody)

  let keyId: string | null = null
  let keyVersion: string | null = null
  let sourceProductId: string | null = null
  let idempotencyKey: string | null = null

  const audit = (entry: Parameters<typeof recordConnectorAudit>[1]) =>
    recordConnectorAudit(req, {
      keyId,
      keyVersion,
      sourceProductId,
      idempotencyKey,
      requestBodySha256,
      durationMs: Date.now() - startedAt,
      ...entry,
    })

  const reject = async (error: unknown, detail?: Record<string, unknown>) => {
    const status = connectorErrorStatus(error)
    await audit({ outcome: 'error', httpStatus: status, errorCode: errorCodeOf(error), detail: detail ?? null })
    return sendConnectorError(res, error)
  }

  // 1. Authentication. Everything else is unreachable without a valid signature.
  try {
    const principal = await authenticateConnectorRequest(req, 'connector:products:write')
    keyId = principal.keyId
    keyVersion = principal.keyVersion
  } catch (error) {
    return reject(error)
  }

  // 2. The product id comes from the path and must be usable as an identifier.
  try {
    sourceProductId = decodeURIComponent(String(req.params.id ?? '')).trim()
  } catch {
    return reject(new ConnectorRequestError('CONTRACT_VALIDATION_FAILED', 'The product id in the path is not valid.'))
  }
  if (!sourceProductId) {
    return reject(new ConnectorRequestError('CONTRACT_VALIDATION_FAILED', 'The product id in the path is required.'))
  }

  // 3. Every write carries an Idempotency-Key. Checked after authentication, so
  //    an error here can be attributed to a known caller.
  idempotencyKey = connectorHeader(req, 'idempotency-key')
  if (!idempotencyKey) {
    return reject(new ConnectorRequestError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required.'))
  }

  // 4. Claim the key before touching a product.
  let claim: { state: string; responseBody?: Record<string, unknown> }
  try {
    claim = await service.claimIdempotencyKey({
      idempotencyKey,
      keyId,
      sourceProductId,
      requestBodySha256,
      now: new Date(),
    })
  } catch (error) {
    return reject(error)
  }

  if (claim.state === 'conflict') {
    return reject(
      new ConnectorRequestError(
        'IDEMPOTENCY_KEY_CONFLICT',
        'This Idempotency-Key was already used with a different request body.'
      )
    )
  }
  if (claim.state === 'in_flight') {
    return reject(
      new ConnectorRequestError(
        'TEMPORARY_UPSTREAM_FAILURE',
        'Another attempt with this Idempotency-Key is still in progress.'
      )
    )
  }
  if (claim.state === 'replay') {
    const stored = claim.responseBody ?? {}
    const productId = typeof stored.productId === 'string' ? stored.productId : null
    await audit({ outcome: 'replayed', httpStatus: 200, productId })
    return sendConnectorJson(res, 200, { ...stored, replayed: true })
  }

  // 5. Validate the neutral DTO. A 422 must be fixed by the caller.
  let dto: any
  try {
    dto = parseProductUpsertRequest(rawBody, sourceProductId)
  } catch (error) {
    await service.releaseIdempotencyClaim(idempotencyKey)
    return reject(error)
  }

  // 6. Write.
  try {
    const { productId, created } = await upsertConnectorProduct(req, dto, service)
    const responseStatus = created ? 201 : 200
    const responseBody = {
      productId,
      version: externalVersionFor(dto.source.revision),
      created,
      replayed: false,
      processedAt: new Date().toISOString(),
    }
    await service.completeIdempotencyClaim({
      idempotencyKey,
      productId,
      responseStatus,
      responseBody,
    })
    await audit({
      outcome: created ? 'created' : 'updated',
      httpStatus: responseStatus,
      productId,
      detail: { sourceRevision: dto.source.revision },
    })
    return sendConnectorJson(res, responseStatus, responseBody)
  } catch (error) {
    await service.releaseIdempotencyClaim(idempotencyKey)
    return reject(error)
  }
}

// The contract serves only PUT on this path; anything else is an unmatched route.
export const GET = connectorNotFound
export const POST = connectorNotFound
export const PATCH = connectorNotFound
export const DELETE = connectorNotFound
