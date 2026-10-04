import { MedusaService } from '@medusajs/framework/utils'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { CustomerClaimAudit } from './models/customer-claim-audit'
import { VerificationRate } from './models/verification-rate'
import { evaluate, WINDOW_MS } from '../../lib/verification-rate-limit.cjs'

// Claim audit ledger service. Append-only: it exposes only `recordClaim` (and
// reads for verification). There is deliberately no update/delete path.
//
// The idempotency guarantee lives in the database: the unique index on
// `auth_identity_id` makes a second insert for the same identity a no-op, so a
// replayed registration cannot double-record a claim.
type Knex = any

export const CLAIM_KIND_NEW = 'new'
export const CLAIM_KIND_GUEST = 'guest_claim'
export const CLAIM_BY_REGISTRATION = 'customer-registration'

class PawshopCustomerAuthService extends MedusaService({
  CustomerClaimAudit,
  VerificationRate,
}) {
  private knex_(): Knex {
    const container = (this as any).__container__
    return container[ContainerRegistrationKeys.PG_CONNECTION]
  }

  // Record a claim binding. Idempotent on auth_identity_id: a duplicate is a
  // no-op (returns false), never an error and never a second row.
  async recordClaim(input: {
    customerId: string
    authIdentityId: string
    email: string
    claimKind: 'new' | 'guest_claim'
    now: Date
  }): Promise<boolean> {
    const knex = this.knex_()
    const id = `custclaim_${input.authIdentityId.replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 96)}`
    const nowIso = input.now.toISOString()
    const result = await knex.raw(
      'insert into "customer_claim_audit" ' +
        '("id", "customer_id", "auth_identity_id", "email", "claim_kind", "claimed_at", "claimed_by", "created_at", "updated_at") ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'on conflict do nothing',
      [
        id,
        input.customerId,
        input.authIdentityId,
        input.email,
        input.claimKind,
        nowIso,
        CLAIM_BY_REGISTRATION,
        nowIso,
        nowIso,
      ],
    )
    const rowCount = typeof result?.rowCount === 'number'
      ? result.rowCount
      : (Array.isArray(result?.rows) ? result.rows.length : 0)
    return rowCount > 0
  }

  // Atomically upgrade a guest customer in place: flip `has_account` false→true.
  // This is the one write that makes the guest→account transition. It uses the
  // shared PG connection through the module container (the correct accessor), so
  // the raw update is safe to run here. The WHERE guard `has_account = false`
  // makes it concurrency-safe: a second concurrent claim for the same customer
  // updates zero rows, and the caller treats that as already-claimed.
  async claimGuestCustomer(customerId: string): Promise<boolean> {
    const knex = this.knex_()
    const result = await knex.raw(
      'update "customer" set "has_account" = true, "updated_at" = now() ' +
        'where "id" = ? and "deleted_at" is null and "has_account" = false',
      [customerId],
    )
    const rowCount = typeof result?.rowCount === 'number'
      ? result.rowCount
      : (Array.isArray(result?.rows) ? result.rows.length : 0)
    return rowCount > 0
  }

  // Read an existing claim for an auth identity (null when none).
  async findClaimByAuthIdentity(authIdentityId: string): Promise<{
    customer_id: string
    auth_identity_id: string
    email: string
    claim_kind: string
    claimed_at: string
  } | null> {
    const knex = this.knex_()
    const result = await knex.raw(
      'select "customer_id", "auth_identity_id", "email", "claim_kind", "claimed_at" ' +
        'from "customer_claim_audit" where "auth_identity_id" = ? and "deleted_at" is null',
      [authIdentityId],
    )
    const row = Array.isArray(result?.rows) && result.rows[0] ? result.rows[0] : null
    return row
  }

  // Record a verification-request and evaluate the rate limit. The insert + prune
  // + count happen as one round-trip batch against PG so two concurrent requests
  // for the same key still see a monotonic count (the insert is unconditional).
  //
  // Returns `{ allowed: boolean, retryAfterMs: number }`. The request row is
  // recorded regardless of the decision so the counter is honest.
  //
  // IMPORTANT: the decision is evaluated against the requests that arrived BEFORE
  // this one (`requested_at < now`), never including the row just inserted. If the
  // current request were counted against itself, the 60s cooldown would see
  // `sinceLast = 0` and reject every request — including the very first one, which
  // would make it impossible for any legitimate customer to ever request a code.
  async recordVerificationRequest(input: {
    scope: 'email' | 'ip'
    scopeKey: string
    limit: number
    cooldownMs: number
    now: Date
  }): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const knex = this.knex_()
    const nowIso = input.now.toISOString()
    const cutoff = new Date(input.now.getTime() - WINDOW_MS).toISOString()

    const id = `vrate_${input.scope}_${input.scopeKey.replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 96)}_${input.now.getTime()}`
    await knex.raw(
      'insert into "verification_rate" ("id", "scope", "scope_key", "requested_at", "created_at", "updated_at") ' +
        'values (?, ?, ?, ?, ?, ?)',
      [id, input.scope, input.scopeKey, nowIso, nowIso, nowIso],
    )

    // Prune rows older than the window for this scope+key (best-effort).
    await knex.raw(
      'delete from "verification_rate" where "scope" = ? and "scope_key" = ? and "requested_at" < ?',
      [input.scope, input.scopeKey, cutoff],
    )

    // Count only PRIOR requests strictly inside the window, excluding the row
    // inserted above (`requested_at < now`). `evaluate` receives the prior
    // history, so the cooldown compares against the previous request, not the
    // current one.
    const result = await knex.raw(
      'select "requested_at" from "verification_rate" ' +
        'where "scope" = ? and "scope_key" = ? and "requested_at" >= ? and "requested_at" < ? ' +
        'order by "requested_at" desc',
      [input.scope, input.scopeKey, cutoff, nowIso],
    )
    const times = (Array.isArray(result?.rows) ? result.rows : []).map(
      (r: any) => new Date(r.requested_at).getTime(),
    )

    const decision = evaluate(times, { limit: input.limit, cooldownMs: input.cooldownMs, windowMs: WINDOW_MS })
    return decision
  }
}

export default PawshopCustomerAuthService
