import { MedusaService } from '@medusajs/framework/utils'
import { ConnectorAuditEvent } from './models/connector-audit-event'
import { ConnectorIdempotencyRecord } from './models/connector-idempotency-record'
import { ConnectorProductMapping } from './models/connector-product-mapping'
import { ConnectorReplayNonce } from './models/connector-replay-nonce'

// How long an Idempotency-Key keeps returning its stored response. Product-id
// stability does not depend on this window — that lives in
// ConnectorProductMapping and is permanent — so an expired key degrades to the
// honest "updated" outcome rather than creating a duplicate product.
const IDEMPOTENCY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

// `response_status` sentinel meaning "a request is working on this key right
// now". A real response is never 0.
const IN_FLIGHT_STATUS = 0
// A claim whose heartbeat has stopped for this long is treated as abandoned
// (the previous attempt died mid-write) and may be taken over.
const CLAIM_STALE_MS = 60 * 1000

export type IdempotencyClaim =
  | { state: 'claimed' }
  | { state: 'in_flight' }
  | { state: 'conflict' }
  | { state: 'replay'; responseStatus: number; responseBody: Record<string, unknown> }

// Postgres unique-violation. Medusa can wrap the driver error, so the whole
// cause chain is inspected rather than only the top-level error.
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; message?: string; cause?: unknown }
    if (candidate.code === '23505') return true
    if (typeof candidate.message === 'string' && /duplicate key value violates unique constraint/i.test(candidate.message)) {
      return true
    }
    current = candidate.cause
  }
  return false
}

export type ConnectorAuditInput = {
  occurredAt: Date
  method: string
  path: string
  keyId?: string | null
  keyVersion?: string | null
  sourceProductId?: string | null
  productId?: string | null
  idempotencyKey?: string | null
  requestBodySha256?: string | null
  // read | created | updated | replayed | rejected | error
  outcome: 'read' | 'created' | 'updated' | 'replayed' | 'rejected' | 'error'
  httpStatus: number
  errorCode?: string | null
  durationMs?: number | null
  detail?: Record<string, unknown> | null
}

class PawshopConnectorService extends MedusaService({
  ConnectorAuditEvent,
  ConnectorIdempotencyRecord,
  ConnectorProductMapping,
  ConnectorReplayNonce,
}) {
  private lastPruneAt = 0

  async findProductMapping(sourceProductId: string) {
    const [mapping] = await this.listConnectorProductMappings({ source_product_id: sourceProductId }, { take: 1 })
    return mapping ?? null
  }

  // Written once, on create. A retry of the same create reuses the row verbatim
  // instead of minting a new handle or a new PawShop product.
  async recordProductMapping(input: {
    sourceProductId: string
    productId: string
    handle: string | null
    revision: number
    externalVersion: string
  }) {
    const existing = await this.findProductMapping(input.sourceProductId)
    if (existing) {
      return this.updateConnectorProductMappings({
        id: existing.id,
        last_revision: input.revision,
        external_version: input.externalVersion,
        handle: existing.handle ?? input.handle,
      })
    }
    return this.createConnectorProductMappings({
      source_product_id: input.sourceProductId,
      product_id: input.productId,
      handle: input.handle,
      last_revision: input.revision,
      external_version: input.externalVersion,
    })
  }

  async findIdempotentRecord(idempotencyKey: string) {
    const [record] = await this.listConnectorIdempotencyRecords({ idempotency_key: idempotencyKey }, { take: 1 })
    return record ?? null
  }

  // Claims the key before any commerce write happens.
  //
  // Running the claim first is what makes the guarantee real: the contract says
  // a retry must never create a second product even when the first response was
  // lost, and a retry is not always sequential — two syncs of the same revision
  // carry the same key. Because the unique index on `idempotency_key` is the
  // mutex, the loser of a race learns it lost *before* it touches a product.
  //
  // States: `claimed` (proceed), `replay` (return the stored response),
  // `conflict` (same key, different body), `in_flight` (another attempt owns it;
  // the caller answers with a retryable 503 and the client comes back).
  async claimIdempotencyKey(input: {
    idempotencyKey: string
    keyId: string
    sourceProductId: string
    requestBodySha256: string
    now: Date
  }): Promise<IdempotencyClaim> {
    try {
      await this.createConnectorIdempotencyRecords({
        idempotency_key: input.idempotencyKey,
        key_id: input.keyId,
        source_product_id: input.sourceProductId,
        product_id: '',
        response_status: IN_FLIGHT_STATUS,
        response_body: {},
        request_body_sha256: input.requestBodySha256,
        expires_at: new Date(input.now.getTime() + IDEMPOTENCY_RETENTION_MS),
      })
      return { state: 'claimed' }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }

    const existing = await this.findIdempotentRecord(input.idempotencyKey)
    if (!existing) return { state: 'claimed' }

    if (existing.request_body_sha256 !== input.requestBodySha256) return { state: 'conflict' }

    if (existing.response_status === IN_FLIGHT_STATUS) {
      const heartbeat = existing.updated_at ? new Date(existing.updated_at as unknown as string).getTime() : 0
      if (input.now.getTime() - heartbeat < CLAIM_STALE_MS) return { state: 'in_flight' }
      // Abandoned mid-write: take the claim over so the client is not blocked
      // forever by an attempt that will never finish.
      await this.updateConnectorIdempotencyRecords({ id: existing.id, request_body_sha256: input.requestBodySha256 })
      return { state: 'claimed' }
    }

    return {
      state: 'replay',
      responseStatus: existing.response_status,
      responseBody: (existing.response_body ?? {}) as Record<string, unknown>,
    }
  }

  // Called only after the commerce write committed. `product_id` is what turns a
  // later replay into the same `productId` without touching a product again.
  async completeIdempotencyClaim(input: {
    idempotencyKey: string
    productId: string
    responseStatus: number
    responseBody: Record<string, unknown>
  }) {
    const existing = await this.findIdempotentRecord(input.idempotencyKey)
    if (!existing) return
    await this.updateConnectorIdempotencyRecords({
      id: existing.id,
      product_id: input.productId,
      response_status: input.responseStatus,
      response_body: input.responseBody,
    })
  }

  // A failed attempt must not leave the key claimed, or the client's one
  // legitimate retry would be refused as in-flight until the claim goes stale.
  async releaseIdempotencyClaim(idempotencyKey: string) {
    try {
      const existing = await this.findIdempotentRecord(idempotencyKey)
      if (existing && existing.response_status === IN_FLIGHT_STATUS) {
        await this.deleteConnectorIdempotencyRecords(existing.id)
      }
    } catch {
      // The stale-claim takeover covers this; never mask the original failure.
    }
  }

  // Returns false when this (keyId, nonce) pair was already claimed — which is
  // exactly the replay condition. The unique index decides; a lost race shows up
  // as a duplicate-key error, not as a second row.
  async claimNonce(input: { keyId: string; nonce: string; expiresAt: number; now: Date }): Promise<boolean> {
    try {
      await this.createConnectorReplayNonces({
        key_id: input.keyId,
        nonce: input.nonce,
        claimed_at: input.now,
        expires_at: new Date(input.expiresAt),
      })
      return true
    } catch (error) {
      if (isUniqueViolation(error)) return false
      throw error
    }
  }

  async recordAudit(input: ConnectorAuditInput) {
    return this.createConnectorAuditEvents({
      occurred_at: input.occurredAt,
      method: input.method,
      path: input.path,
      key_id: input.keyId ?? null,
      key_version: input.keyVersion ?? null,
      source_product_id: input.sourceProductId ?? null,
      product_id: input.productId ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      request_body_sha256: input.requestBodySha256 ?? null,
      outcome: input.outcome,
      http_status: input.httpStatus,
      error_code: input.errorCode ?? null,
      duration_ms: input.durationMs ?? null,
      detail: input.detail ?? null,
    })
  }

  async listAudit(filters: { sourceProductId?: string; idempotencyKey?: string; limit?: number } = {}) {
    const where: Record<string, unknown> = {}
    if (filters.sourceProductId) where.source_product_id = filters.sourceProductId
    if (filters.idempotencyKey) where.idempotency_key = filters.idempotencyKey
    return this.listConnectorAuditEvents(where, {
      take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
      order: { occurred_at: 'DESC' },
    })
  }

  // Best-effort housekeeping. Guarded so the request path pays for it at most
  // once an hour, and safe to run concurrently from several instances because
  // the deletes are idempotent.
  async pruneExpired(now: Date = new Date()): Promise<void> {
    if (now.getTime() - this.lastPruneAt < PRUNE_INTERVAL_MS) return
    this.lastPruneAt = now.getTime()
    try {
      await this.deleteConnectorReplayNonces({ expires_at: { $lt: now } })
      await this.deleteConnectorIdempotencyRecords({ expires_at: { $lt: now } })
    } catch {
      // Housekeeping must never fail a request. The next window retries.
    }
  }
}

export default PawshopConnectorService
