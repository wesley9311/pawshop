import { MedusaError } from '@medusajs/framework/utils'
import { AbstractAuthModuleProvider } from '@medusajs/framework/utils'
import type {
  AuthIdentityProviderService,
  AuthenticationInput,
  AuthenticationResponse,
  Logger,
} from '@medusajs/framework/types'
import { AuthVerification } from '@medusajs/auth/dist/models'
import {
  deriveHmacKey,
  normalizeCode,
  digestCode,
} from '../../lib/otp-code.cjs'

// Passwordless "email + 6-digit OTP" authentication provider.
//
// This is the auth counterpart to the `pawshop-otp-verification` VERIFICATION
// provider (`verif_otp`). That provider only proves email ownership and never
// issues a JWT; this provider is what turns a verified OTP into an authenticated
// session by returning a valid authIdentity from `authenticate()`.
//
// Product decision (Owner, Phase 2):
//   - New users register WITHOUT a password: email → 6-digit OTP → create account.
//   - Existing otp-email users log in with email → OTP (OTP is a one-time factor,
//     never a long-term password).
//   - Existing emailpass users keep email+password and are untouched; they may
//     also use OTP login if they choose.
//   - Setting a password is deferred to a later Account Settings phase via the
//     official emailpass `updateProvider` path — it is NOT in this release.
//
// Identity model (no bypass, no fabricated password):
//   - `register()` creates/returns an auth identity whose `provider_identity` is
//     `provider='otp-email'`, `entity_id=email`, with NO password and NO actor.
//     It NEVER writes a password hash and NEVER touches the emailpass provider.
//   - `authenticate()` validates the presented OTP against the `auth_verification`
//     row (the SAME keyed-HMAC digest the `verif_otp` provider stores), then
//     returns the identity. The auth route issues the JWT from `app_metadata`.
//
// OTP security (reuses the `otp-code.cjs` contract):
//   - 6-digit CSPRNG code, keyed HMAC-SHA256 digest (never a bare sha256).
//   - one-time: `authenticate()` atomically consumes the code via a conditional
//     `verified_at IS NULL` update, so a second use is rejected.
//   - TTL and resend-invalidation are owned by the `verif_otp` request path.

const DEFAULT_TTL_SECONDS = 900 // 15 minutes (matches verif_otp)

type Options = {
  hmac_secret?: string
  ttl_seconds?: number
}

type InjectedDependencies = {
  logger?: Logger
  authVerificationService?: {
    list: (filters: Record<string, unknown>, config: Record<string, unknown>, sharedContext?: unknown) => Promise<VerificationRow[]>
    update: (data: Record<string, unknown>, sharedContext?: unknown) => Promise<Record<string, unknown>>
  }
  baseRepository?: {
    getActiveManager: (context?: unknown) => {
      nativeUpdate: <E extends object>(entityName: E, where: Record<string, unknown>, data: Record<string, unknown>) => Promise<number>
    }
  }
  // Unscoped services (the auth module's own, NOT the provider-scoped wrapper) used
  // for cross-provider identity binding: an existing emailpass user must be able to
  // add an `otp-email` provider identity to their SAME auth_identity (same customer),
  // rather than minting a detached identity.
  providerIdentityService?: {
    list: (filters: Record<string, unknown>, config: Record<string, unknown>, sharedContext?: unknown) => Promise<ProviderIdentityRow[]>
    create: (data: Record<string, unknown>, sharedContext?: unknown) => Promise<Record<string, unknown>>
  }
}

type ProviderIdentityRow = {
  id: string
  provider: string
  entity_id: string
  auth_identity_id: string
}

type VerificationRow = {
  id: string
  auth_identity_id: string
  entity_id: string
  entity_type: string
  code_provider: string
  provider_metadata?: Record<string, unknown> | null
  verified_at?: Date | null
  requested_at: Date
}

class OtpEmailAuthProvider extends AbstractAuthModuleProvider {
  static identifier = 'otp-email'
  static DISPLAY_NAME = 'Email / One-Time Code'

  protected logger_: Logger
  protected options_: Options
  private readonly hmacKey_: Buffer
  private readonly authVerificationService_: InjectedDependencies['authVerificationService']
  private readonly baseRepository_: InjectedDependencies['baseRepository']
  private readonly providerIdentityService_: InjectedDependencies['providerIdentityService']

  constructor(container: InjectedDependencies, options: Options = {}) {
    // The base class declares no constructor; mirror the emailpass provider's
    // `super(...arguments)` so TS does not reject an empty super() call.
    super()
    this.logger_ = container.logger ?? (console as unknown as Logger)
    this.options_ = options
    this.authVerificationService_ = container.authVerificationService
    this.baseRepository_ = container.baseRepository
    this.providerIdentityService_ = container.providerIdentityService

    const secret = options.hmac_secret
    if (!secret || typeof secret !== 'string' || secret.length < 32) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'otp-email auth provider requires `hmac_secret` (a >=32-char secret) in its options.',
      )
    }
    this.hmacKey_ = deriveHmacKey(secret)
  }

  static validateOptions(options: Record<string, unknown>): void {
    const secret = options.hmac_secret
    if (!secret || typeof secret !== 'string' || secret.length < 32) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'otp-email auth provider option `hmac_secret` must be a string of at least 32 characters.',
      )
    }
    const ttl = options.ttl_seconds
    if (ttl != null && (!Number.isInteger(ttl) || (ttl as number) < 60 || (ttl as number) > 3600)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'otp-email auth provider option `ttl_seconds` must be an integer between 60 and 3600.',
      )
    }
  }

  private ttlMs_(): number {
    return (this.options_.ttl_seconds ?? DEFAULT_TTL_SECONDS) * 1000
  }

  // Strip `app_metadata` (which carries the customer_id actor binding) from an
  // identity before returning it from `register`. The register route issues a
  // token from `app_metadata.customer_id`; returning a bound identity would mint
  // an actor-bound token for ANY email with no OTP/password — an account-takeover
  // vector. The OTP flow only ever needs an ACTORLESS token (to request/confirm a
  // code and later bind the actor through `/store/customers`), so `register`
  // always returns the identity with the actor binding stripped.
  private stripActor_(authIdentity: AuthenticationResponse['authIdentity']) {
    if (!authIdentity) return authIdentity
    const copy = JSON.parse(JSON.stringify(authIdentity)) as typeof authIdentity
    if (copy && copy.app_metadata) {
      delete (copy.app_metadata as Record<string, unknown>).customer_id
    }
    return copy
  }

  // Idempotent get-or-create for the OTP flow, with cross-provider binding.
  //
  // Unlike emailpass (which refuses an existing email), this always returns
  // `success: true` + an ACTORLESS identity so the caller can run
  // request→confirm→bind-actor for both new and existing emails:
  //
  //   - no identity for the email              → create an otp-email identity.
  //   - an otp-email identity exists           → idempotent return (already bound).
  //   - an emailpass/google identity exists    → add an otp-email provider identity
  //     to the SAME auth_identity (same customer), so the owner can log in with OTP
  //     without losing their customer/orders. No detached identity, no customer
  //     duplication, no password write.
  //
  // The actor is never exposed here; the returned identity is always actorless
  // (`app_metadata.customer_id` stripped) so the register route mints only an
  // actorless token. Account takeover is impossible: that token cannot reach
  // `/store/customers/me` or `/store/orders`, and the `authVerificationsPerActor`
  // gate blocks `token/refresh` from upgrading it to an actor-bound token without
  // a verified OTP.
  async register(data: AuthenticationInput, authIdentityService: AuthIdentityProviderService): Promise<AuthenticationResponse> {
    const email = typeof data.body?.email === 'string' ? data.body.email.trim().toLowerCase() : ''
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(email)) {
      return { success: false, error: 'Email should be a valid email address' }
    }

    let authIdentity
    try {
      // Provider-scoped retrieve: finds an identity that already has an otp-email
      // provider identity for this email.
      authIdentity = await authIdentityService.retrieve({ entity_id: email })
    } catch (error) {
      if ((error as { type?: string }).type !== MedusaError.Types.NOT_FOUND) {
        return { success: false, error: (error as Error).message }
      }
    }

    if (authIdentity) {
      // Already has an otp-email identity — idempotent.
      return { success: true, authIdentity: this.stripActor_(authIdentity) }
    }

    // No otp-email identity. Check whether another provider (emailpass/google)
    // already owns this email, via the unscoped provider-identity service.
    const providerIdentityService = this.providerIdentityService_
    if (providerIdentityService) {
      const existing = await providerIdentityService.list({ entity_id: email }, {})
      if (existing.length) {
        // Bind an otp-email provider identity to the existing auth_identity, so the
        // customer keeps their existing account and orders. This is the one write
        // that adds a provider (never a password, never a new customer).
        const authIdentityId = existing[0].auth_identity_id
        await providerIdentityService.create({
          auth_identity_id: authIdentityId,
          entity_id: email,
          provider: 'otp-email',
          provider_metadata: {},
        })
        // Re-fetch through the provider-scoped service to return the bound identity.
        try {
          authIdentity = await authIdentityService.retrieve({ entity_id: email })
        } catch {
          return { success: false, error: 'Failed to bind OTP sign-in to this email' }
        }
        return { success: true, authIdentity: this.stripActor_(authIdentity) }
      }
    }

    // Truly new email: create a fresh otp-email identity (no password, no actor).
    authIdentity = await authIdentityService.create({
      entity_id: email,
      provider_metadata: {},
    })

    // Always actorless: the caller must still pass the OTP before an actor binds.
    return { success: true, authIdentity: this.stripActor_(authIdentity) }
  }

  // OTP login. `data.body = { email, code }`. Validates the presented 6-digit code
  // against the `auth_verification` row (keyed HMAC + atomic one-time claim), then
  // returns the identity so the auth route issues a JWT. An anonymous actorless
  // identity yields an actorless token (caller then binds via `/store/customers`);
  // a bound identity yields a full login token.
  async authenticate(data: AuthenticationInput, authIdentityService: AuthIdentityProviderService): Promise<AuthenticationResponse> {
    const email = typeof data.body?.email === 'string' ? data.body.email.trim().toLowerCase() : ''
    const code = typeof data.body?.code === 'string' ? data.body.code : ''
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(email)) {
      return { success: false, error: 'Email should be a valid email address' }
    }
    if (!code) {
      return { success: false, error: 'Verification code is required' }
    }

    const normalized = normalizeCode(code)
    if (normalized === null) {
      return { success: false, error: 'Verification code is invalid or already used' }
    }

    if (!this.authVerificationService_) {
      return { success: false, error: 'OTP verification is not available' }
    }

    const digest = digestCode(this.hmacKey_, normalized)
    const rows = await this.authVerificationService_.list(
      { provider_metadata: { code_hash: digest } },
      {},
      {},
    )

    const verification = rows[0]
    if (!verification || verification.verified_at) {
      return { success: false, error: 'Verification code is invalid or already used' }
    }

    // The presented email must match the entity the code was issued to, so a code
    // requested for A cannot authenticate B.
    if (verification.entity_id !== email) {
      return { success: false, error: 'Verification code is invalid or already used' }
    }

    const expiresAt = new Date(verification.requested_at).getTime() + this.ttlMs_()
    if (expiresAt <= Date.now()) {
      return { success: false, error: 'Verification code has expired' }
    }

    // Atomic one-time claim: only flip verified_at when it is still NULL. This
    // closes the check-then-update race so two concurrent logins with the same
    // code cannot both succeed.
    const verifiedAt = new Date(Date.now())
    if (this.baseRepository_) {
      const manager = this.baseRepository_.getActiveManager({})
      const affected = await manager.nativeUpdate(
        AuthVerification,
        { id: verification.id, verified_at: null },
        { verified_at: verifiedAt },
      )
      if (affected === 0) {
        return { success: false, error: 'Verification code is invalid or already used' }
      }
    } else {
      await this.authVerificationService_.update(
        { id: verification.id, verified_at: verifiedAt },
        {},
      )
    }

    const authIdentity = await authIdentityService.retrieve({ entity_id: email })
    return { success: true, authIdentity }
  }
}

export default OtpEmailAuthProvider
