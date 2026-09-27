import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { publicPathFromMountedUrl, readConnectorCredentials, verifyConnectorRequest } from './connector-auth.cjs'
import { ConnectorRequestError, connectorErrorBody, connectorErrorStatus } from './connector-errors.cjs'
import { PAWSHOP_CONNECTOR_MODULE } from '../modules/pawshop-connector'

// Shared plumbing for every `/connector/v1` route.
//
// Three things here are worth stating explicitly:
//
//  1. The signature covers the RAW request bytes. Medusa's body parser is
//     configured with `preserveRawBody` for this namespace precisely so the HMAC
//     is computed over what the sender actually transmitted, never over a
//     re-serialisation of the parsed body. Re-serialising would be a latent
//     signature bypass the day a body carries a key order or a number JSON
//     round-trips differently.
//  2. Credentials are read from the process environment and cached only briefly.
//     A rotation is two env-file slots plus a reload, so a 30s cache keeps a
//     redeploy from being needed while still picking a change up quickly.
//  3. A failure to write an audit row never changes the HTTP outcome. The audit
//     is a requirement, but it is not allowed to turn a committed product write
//     into an error the caller would retry.

const CREDENTIAL_CACHE_TTL_MS = 30_000

let credentialCache: { at: number; credentials: ReturnType<typeof readConnectorCredentials> } | null = null

export function connectorCredentials() {
  const now = Date.now()
  if (!credentialCache || now - credentialCache.at > CREDENTIAL_CACHE_TTL_MS) {
    // A missing or half-configured credential throws here and is mapped to
    // CONNECTOR_NOT_CONFIGURED by the caller: fail closed, visibly.
    credentialCache = { at: now, credentials: readConnectorCredentials(process.env) }
  }
  return credentialCache.credentials
}

export function connectorService(req: MedusaRequest) {
  return req.scope.resolve(PAWSHOP_CONNECTOR_MODULE) as any
}

export function rawBodyOf(req: MedusaRequest): string {
  const raw = (req as unknown as { rawBody?: unknown }).rawBody
  if (raw === undefined || raw === null) return ''
  return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
}

// nginx rewrites `/api/connector/v1/` onto `/connector/v1/`, so the canonical
// path the caller signed has to be rebuilt. See connector-auth.cjs.
export function connectorPublicPath(req: MedusaRequest): string {
  const originalUrl = (req as unknown as { originalUrl?: string }).originalUrl || req.url || ''
  return publicPathFromMountedUrl(originalUrl)
}

export async function authenticateConnectorRequest(req: MedusaRequest, requiredScope: string) {
  const service = connectorService(req)
  return verifyConnectorRequest({
    headers: req.headers as Record<string, string | string[] | undefined>,
    method: req.method,
    publicPath: connectorPublicPath(req),
    rawBody: rawBodyOf(req),
    requiredScope,
    credentials: connectorCredentials(),
    claimNonce: ({ keyId, nonce, expiresAt }: { keyId: string; nonce: string; expiresAt: number }) =>
      service.claimNonce({ keyId, nonce, expiresAt, now: new Date() }),
  })
}

export function sendConnectorError(res: MedusaResponse, error: unknown) {
  const normalized = error instanceof ConnectorRequestError ? error : toConnectorError(error)
  res.status(connectorErrorStatus(normalized))
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  // `details` is an additive field for contract violations; the contract's
  // required `error` / `code` / `retryable` triple is always present.
  return res.json(connectorErrorBody(normalized))
}

export function sendConnectorJson(res: MedusaResponse, status: number, body: unknown) {
  res.status(status)
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  return res.json(body)
}

export function connectorHeader(req: MedusaRequest, name: string): string | null {
  const value = (req.headers as Record<string, string | string[] | undefined>)[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

// The contract answers any unmatched method/path with `404 NOT_FOUND`, without
// requiring a credential — mirrored here so a method typo produces the contract's
// error body rather than Medusa's default shape.
export async function connectorNotFound(req: MedusaRequest, res: MedusaResponse) {
  await recordConnectorAudit(req, { outcome: 'rejected', httpStatus: 404, errorCode: 'NOT_FOUND' })
  return sendConnectorError(res, new ConnectorRequestError('NOT_FOUND', 'Route not found.'))
}

function toConnectorError(error: unknown): ConnectorRequestError {
  const message = error instanceof Error ? error.message : String(error)
  // A credential that is absent or half-configured is a deployment fault, not a
  // caller fault: say so, and make it non-retryable so the caller surfaces it.
  if (/PawShop Connector credential/i.test(message)) {
    return new ConnectorRequestError('CONNECTOR_NOT_CONFIGURED', 'The PawShop Connector is not configured.')
  }
  return new ConnectorRequestError('INTERNAL_ERROR', message)
}

// Awaited before the response is sent so the audit is deterministic (and
// testable), but every failure is swallowed: an audit problem must never turn a
// committed product write into an error the caller would retry.
export async function recordConnectorAudit(
  req: MedusaRequest,
  entry: {
    keyId?: string | null
    keyVersion?: string | null
    sourceProductId?: string | null
    productId?: string | null
    idempotencyKey?: string | null
    requestBodySha256?: string | null
    outcome: 'read' | 'created' | 'updated' | 'replayed' | 'rejected' | 'error'
    httpStatus: number
    errorCode?: string | null
    durationMs?: number | null
    detail?: Record<string, unknown> | null
  }
) {
  const service = connectorService(req)
  let path = '/connector/v1'
  try {
    path = connectorPublicPath(req)
  } catch {
    // The URL was outside the namespace; keep the default instead of failing.
  }
  try {
    await service.recordAudit({ occurredAt: new Date(), method: req.method || 'GET', path, ...entry })
  } catch (error) {
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER) as { warn: (message: string) => void }
    logger.warn(
      `[pawshop-connector] audit write failed for ${req.method} ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}
