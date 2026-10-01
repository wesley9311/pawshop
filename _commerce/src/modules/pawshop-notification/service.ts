import { MedusaService } from '@medusajs/framework/utils'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TransactionalEmailSent } from './models/transactional-email-sent'
import {
  MAX_ATTEMPTS,
  SEND_LEASE_MS,
  SEND_STATES,
} from '../../lib/transactional-order-email.cjs'

// How long a row is retained before it may be pruned. The send state must
// survive while a redelivery is still possible (BullMQ redelivery is minutes, a
// workflow compensation at most hours, and the retry backoff tops out at 180m),
// so a generous but bounded window is more than enough and keeps the table from
// growing without limit.
const SENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// A claim result tells the caller exactly what to do next.
export type SendClaim =
  | { state: 'claim' }          // this worker owns the lease; attempt the send
  | { state: 'skip_sent' }      // already sent (terminal) — do not send
  | { state: 'skip_terminal' }  // permanent terminal state — do not send
  | { state: 'in_flight' }      // another worker holds a live lease / backoff not elapsed

// A row returned by the recovery scan. It carries only the non-sensitive
// locating fields the retry path needs to re-query live business data.
export type EligibleRow = {
  idempotency_key: string
  notification_type: string
  entity_id: string
  attempt_count: number
}

// The knex query builder from the shared PG connection. `__pg_connection__` is
// registered as a shared resource on every module's container.
type Knex = any

class PawshopNotificationService extends MedusaService({
  TransactionalEmailSent,
}) {
  private knex_(): Knex {
    const container = (this as any).__container__
    return container[ContainerRegistrationKeys.PG_CONNECTION]
  }

  // Atomically claim the send lease for an idempotency key, or report why it
  // cannot be claimed. The whole decision is one INSERT ... ON CONFLICT plus one
  // conditional UPDATE ... RETURNING, so two workers racing for the same event
  // cannot both claim it: the UPDATE's WHERE clause admits only a row that is
  // pending, failed (backoff elapsed, under max attempts), or a stale sending,
  // and Postgres serialises them. A successful claim increments attempt_count.
  async tryClaim(input: {
    idempotencyKey: string
    notificationType: string
    entityId: string
    now: Date
  }): Promise<SendClaim> {
    const knex = this.knex_()
    const { idempotencyKey, notificationType, entityId, now } = input
    const nowIso = now.toISOString()
    const leaseExpiry = new Date(now.getTime() + SEND_LEASE_MS).toISOString()
    const expiresAt = new Date(now.getTime() + SENT_RETENTION_MS).toISOString()

    // 1. Ensure a row exists in `pending`. The unique index is the dedup guard;
    //    a duplicate insert is a no-op, not an error. `ON CONFLICT DO NOTHING`
    //    (without a conflict target) matches the partial unique index.
    const id = `txnemail_${idempotencyKey.replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 96)}`
    await knex.raw(
      'insert into "transactional_email_sent" ' +
        '("id", "idempotency_key", "notification_type", "entity_id", "status", "attempt_count", "expires_at", "created_at", "updated_at") ' +
        'values (?, ?, ?, ?, ?, 0, ?, ?, ?) ' +
        'on conflict do nothing',
      [id, idempotencyKey, notificationType, entityId, SEND_STATES.PENDING, expiresAt, nowIso, nowIso],
    )

    // 2. Atomically take the lease: pending / failed (backoff elapsed, under
    //    max attempts) / stale-sending → sending, and bump the attempt count.
    const result = await knex.raw(
      'update "transactional_email_sent" ' +
        'set "status" = ?, "claimed_at" = ?, "lease_expires_at" = ?, ' +
        '"attempt_count" = "attempt_count" + 1, "next_attempt_at" = null, "updated_at" = ? ' +
        'where "idempotency_key" = ? and "deleted_at" is null ' +
        'and "attempt_count" < ? ' +
        'and ("status" = ? ' +
        '  or ("status" = ? and ("next_attempt_at" is null or "next_attempt_at" <= ?)) ' +
        '  or ("status" = ? and "lease_expires_at" < ?)) ' +
        'returning "id", "attempt_count"',
      [SEND_STATES.SENDING, nowIso, leaseExpiry, nowIso, idempotencyKey,
        MAX_ATTEMPTS, SEND_STATES.PENDING, SEND_STATES.FAILED, nowIso, SEND_STATES.SENDING, nowIso],
    )
    const claimedRows = Array.isArray(result?.rows) ? result.rows : (result?.rowCount ? [{ id: '' }] : [])

    if (claimedRows.length > 0) return { state: 'claim' }

    // 3. The lease was not taken — read the row to say why.
    const read = await knex.raw(
      'select "status", "lease_expires_at", "attempt_count" from "transactional_email_sent" ' +
        'where "idempotency_key" = ? and "deleted_at" is null',
      [idempotencyKey],
    )
    const row = Array.isArray(read?.rows) && read.rows[0] ? read.rows[0] : null

    // 4. A row at or past max attempts is declared terminal so it cannot retry.
    if (row && Number(row.attempt_count) >= MAX_ATTEMPTS && row.status !== SEND_STATES.SENT && row.status !== SEND_STATES.TERMINAL) {
      await this.markTerminal({ idempotencyKey, errorCategory: 'max_attempts', now }).catch(() => undefined)
      return { state: 'skip_terminal' }
    }

    if (row?.status === SEND_STATES.SENT) return { state: 'skip_sent' }
    if (row?.status === SEND_STATES.TERMINAL) return { state: 'skip_terminal' }
    // remaining cases: sending with a live lease (in_flight), or failed whose
    // backoff has not yet elapsed (try again later).
    return { state: 'in_flight' }
  }

  // Mark a send as accepted by the relay. Only a row currently in `sending` may
  // transition to `sent`; the conditional update makes it a no-op if the lease
  // was taken over or the row was already finalised.
  async markSent(input: { idempotencyKey: string; now: Date }): Promise<void> {
    const knex = this.knex_()
    await knex.raw(
      'update "transactional_email_sent" ' +
        'set "status" = ?, "sent_at" = ?, "lease_expires_at" = null, "next_attempt_at" = null, "updated_at" = ? ' +
        'where "idempotency_key" = ? and "deleted_at" is null and "status" = ?',
      [SEND_STATES.SENT, input.now.toISOString(), input.now.toISOString(), input.idempotencyKey, SEND_STATES.SENDING],
    )
  }

  // Record a failed send. Only a row in `sending` may fail. `retryable` decides
  // whether the row returns to `failed` (with a scheduled `next_attempt_at`) or
  // goes straight to `terminal` (permanent error). A row that has already hit
  // MAX_ATTEMPTS is terminal as well.
  async markFailed(input: {
    idempotencyKey: string
    errorCategory: string
    retryable: boolean
    nextAttemptAt: string
    now: Date
  }): Promise<void> {
    const knex = this.knex_()
    if (!input.retryable) {
      await this.markTerminal({ idempotencyKey: input.idempotencyKey, errorCategory: input.errorCategory, now: input.now })
      return
    }
    // Transient: return to failed, schedule the next attempt, and (if this was
    // the last allowed attempt) go terminal instead of scheduling a 6th try.
    await knex.raw(
      'update "transactional_email_sent" ' +
        'set "status" = case when "attempt_count" >= ? then ? else ? end, ' +
        '"error_category" = ?, "lease_expires_at" = null, ' +
        '"next_attempt_at" = case when "attempt_count" >= ? then null::timestamptz else ?::timestamptz end, "updated_at" = ? ' +
        'where "idempotency_key" = ? and "deleted_at" is null and "status" = ?',
      [MAX_ATTEMPTS, SEND_STATES.TERMINAL, SEND_STATES.FAILED,
        input.errorCategory, MAX_ATTEMPTS, input.nextAttemptAt, input.now.toISOString(),
        input.idempotencyKey, SEND_STATES.SENDING],
    )
  }

  // Move a row to the permanent terminal state. Idempotent: only a non-terminal,
  // non-sent row can transition.
  async markTerminal(input: { idempotencyKey: string; errorCategory: string; now: Date }): Promise<void> {
    const knex = this.knex_()
    await knex.raw(
      'update "transactional_email_sent" ' +
        'set "status" = ?, "error_category" = ?, "lease_expires_at" = null, "next_attempt_at" = null, "updated_at" = ? ' +
        'where "idempotency_key" = ? and "deleted_at" is null and "status" in (?, ?)',
      [SEND_STATES.TERMINAL, input.errorCategory, input.now.toISOString(),
        input.idempotencyKey, SEND_STATES.SENDING, SEND_STATES.FAILED],
    )
  }

  // Read the current attempt count for an idempotency key, so the caller can
  // derive the backoff for the next retry (attempt count was already bumped by
  // the claim). Returns 0 when the row is absent.
  async readAttemptCount(input: { idempotencyKey: string }): Promise<number> {
    const knex = this.knex_()
    const result = await knex.raw(
      'select "attempt_count" from "transactional_email_sent" ' +
        'where "idempotency_key" = ? and "deleted_at" is null',
      [input.idempotencyKey],
    )
    const row = Array.isArray(result?.rows) && result.rows[0] ? result.rows[0] : null
    return row ? Number(row.attempt_count) : 0
  }

  // Scan rows that are eligible for a (re)send, for the recovery worker. This
  // returns failed rows whose backoff has elapsed and stale `sending` rows whose
  // lease expired — each with only the non-sensitive locating fields. The worker
  // then re-queries live business data by notification_type + entity_id and
  // calls tryClaim again to re-acquire the lease atomically.
  async scanEligible(now: Date, limit = 100): Promise<EligibleRow[]> {
    const knex = this.knex_()
    const nowIso = now.toISOString()
    const result = await knex.raw(
      'select "idempotency_key", "notification_type", "entity_id", "attempt_count" ' +
        'from "transactional_email_sent" ' +
        'where "deleted_at" is null ' +
        'and "attempt_count" < ? ' +
        'and (("status" = ? and ("next_attempt_at" is null or "next_attempt_at" <= ?)) ' +
        '  or ("status" = ? and "lease_expires_at" < ?)) ' +
        'order by "next_attempt_at" asc nulls first ' +
        'limit ?',
      [MAX_ATTEMPTS, SEND_STATES.FAILED, nowIso, SEND_STATES.SENDING, nowIso, limit],
    )
    const rows = Array.isArray(result?.rows) ? result.rows : []
    return rows.map((r: any) => ({
      idempotency_key: r.idempotency_key,
      notification_type: r.notification_type,
      entity_id: r.entity_id,
      attempt_count: Number(r.attempt_count),
    }))
  }
}

export default PawshopNotificationService
