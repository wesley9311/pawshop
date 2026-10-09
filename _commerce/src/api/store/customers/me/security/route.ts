import type { MedusaStoreRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { commerceIsOpen } from '../../../../../lib/production-modes.cjs'

type ProviderIdentity = { provider: string; entity_id: string; provider_metadata?: Record<string, unknown> | null }
type Identity = { id: string; app_metadata?: Record<string, unknown>; provider_identities?: ProviderIdentity[] }
type AuthService = {
  retrieveAuthIdentity: (id: string, config: { relations: string[] }) => Promise<Identity>
  authenticate: (provider: string, data: Record<string, unknown>) => Promise<{ success: boolean; authIdentity?: Identity }>
  createProviderIdentities: (data: Record<string, unknown>) => Promise<unknown>
  updateProvider: (provider: string, data: Record<string, unknown>) => Promise<{ success: boolean; authIdentity?: Identity }>
}

async function signedInContext(req: MedusaStoreRequest, res: MedusaResponse) {
  if (!commerceIsOpen(process.env.PAWSHOP_MODE)) {
    res.status(503).json({ type: 'not_allowed', message: 'PawShop storefront APIs are not open.' })
    return null
  }
  const context = req.auth_context as { actor_id?: string; auth_identity_id?: string } | undefined
  if (!context?.actor_id || !context.auth_identity_id) {
    res.status(401).json({ type: 'unauthorized', message: 'Customer sign-in required.' })
    return null
  }
  const customerService = req.scope.resolve(Modules.CUSTOMER) as {
    retrieveCustomer: (id: string) => Promise<{ email: string; has_account: boolean }>
  }
  const auth = req.scope.resolve(Modules.AUTH) as AuthService
  const customer = await customerService.retrieveCustomer(context.actor_id)
  const identity = await auth.retrieveAuthIdentity(context.auth_identity_id, { relations: ['provider_identities'] })
  if (!customer?.has_account || identity.app_metadata?.customer_id !== context.actor_id) {
    res.status(401).json({ type: 'unauthorized', message: 'Customer sign-in required.' })
    return null
  }
  const email = customer.email.trim().toLowerCase()
  const providers = identity.provider_identities || []
  const otpEnabled = providers.some(p => p.provider === 'otp-email' && p.entity_id === email)
  const passwordProvider = providers.find(p => p.provider === 'emailpass' && p.entity_id === email)
  return {
    auth, identity, email, otpEnabled,
    passwordIdentityExists: !!passwordProvider,
    passwordSet: typeof passwordProvider?.provider_metadata?.password === 'string',
  }
}

export async function GET(req: MedusaStoreRequest, res: MedusaResponse) {
  const context = await signedInContext(req, res)
  if (!context) return
  res.status(200).json({ email_code_enabled: true, password_set: context.passwordSet })
}

export async function POST(req: MedusaStoreRequest, res: MedusaResponse) {
  const context = await signedInContext(req, res)
  if (!context) return
  const body = (req.body || {}) as { current_password?: unknown; new_password?: unknown; code?: unknown }
  if (typeof body.new_password !== 'string' || body.new_password.length < 12 || body.new_password.length > 128) {
    return res.status(400).json({ type: 'invalid_data', message: 'New password must be 12 to 128 characters.' })
  }

  if (context.passwordSet) {
    if (typeof body.current_password !== 'string' || !body.current_password) {
      return res.status(400).json({ type: 'invalid_data', message: 'Current password is required.' })
    }
    const verified = await context.auth.authenticate('emailpass', {
      actor_type: 'customer', body: { email: context.email, password: body.current_password },
    })
    if (!verified.success || verified.authIdentity?.id !== context.identity.id) {
      return res.status(401).json({ type: 'unauthorized', message: 'Current password is incorrect.' })
    }
  } else {
    if (!context.otpEnabled) {
      return res.status(409).json({ type: 'conflict', message: 'Email verification is unavailable for this account.' })
    }
    if (typeof body.code !== 'string' || !/^[0-9]{6}$/.test(body.code)) {
      return res.status(400).json({ type: 'invalid_data', message: 'A six-digit email code is required.' })
    }
    // The existing otp-email provider consumes the code atomically. Check the
    // returned identity against the signed-in token before writing a password.
    const verified = await context.auth.authenticate('otp-email', {
      actor_type: 'customer', body: { email: context.email, code: body.code },
    })
    if (!verified.success || verified.authIdentity?.id !== context.identity.id) {
      return res.status(401).json({ type: 'unauthorized', message: 'Email code is invalid or expired.' })
    }
    if (!context.passwordIdentityExists) {
      await context.auth.createProviderIdentities({
        auth_identity_id: context.identity.id,
        entity_id: context.email,
        provider: 'emailpass',
        provider_metadata: {},
      })
    }
  }

  const updated = await context.auth.updateProvider('emailpass', {
    entity_id: context.email, password: body.new_password,
  })
  if (!updated.success || updated.authIdentity?.id !== context.identity.id) {
    return res.status(500).json({ type: 'unexpected_state', message: 'Password could not be saved. Please try again.' })
  }
  res.status(200).json({ success: true, password_set: true })
}
