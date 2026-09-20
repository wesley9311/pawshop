import type { ExecArgs } from '@medusajs/framework/types'
import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'

// One-time, operator-invoked binding of the owner's Google auth identity to the
// existing admin user. It is NOT a social-signup path: it refuses to create any
// user, refuses to bind by email, and refuses to rebind an identity that is
// already attached to an actor.
//
// The Google auth identity must already exist (produced by the owner's first
// "Continue with Google" attempt, which the provider creates with an empty
// app_metadata). This script then writes app_metadata.user_id onto that identity
// through the official auth module service, so the next Google sign-in produces a
// JWT with a real actor_id and the admin middleware admits it.
//
// Binding is keyed on two STABLE identifiers, never on email:
//   - GOOGLE_PROVIDER_SUB: Google's `sub` claim, persisted as the provider
//     identity's entity_id by the provider on first sign-in.
//   - ADMIN_USER_EMAIL: used only to locate the target admin user row; the
//     persisted binding stores the stable user id, not the email.
//
// Invocation:
//   GOOGLE_PROVIDER_SUB=<google-sub> ADMIN_USER_EMAIL=<admin-email> \
//     npx medusa exec ./src/scripts/bind-google-identity.ts

type ProviderIdentity = {
  id: string
  provider: string
  entity_id: string
}

type AuthIdentity = {
  id: string
  app_metadata?: Record<string, unknown>
  provider_identities?: ProviderIdentity[]
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

export default async function bindGoogleIdentity({ container }: ExecArgs) {
  const googleSub = requiredEnv('GOOGLE_PROVIDER_SUB')
  const adminEmail = requiredEnv('ADMIN_USER_EMAIL').toLowerCase()

  const auth = container.resolve(Modules.AUTH)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  // Locate the target admin user. email is a search key only; the persisted
  // binding stores the stable user id.
  const { data: users } = await query.graph({
    entity: 'user',
    fields: ['id', 'email'],
    filters: { email: adminEmail },
  })
  if (users.length !== 1) {
    throw new Error(
      `Expected exactly one admin user for ${adminEmail}, found ${users.length}. ` +
      'Refusing to bind to an ambiguous or missing admin user.',
    )
  }
  const adminUserId = users[0].id as string

  // Locate the Google auth identity by the stable Google `sub` (provider
  // identity entity_id). No email is involved in this match.
  const { data: identities } = (await query.graph({
    entity: 'auth_identity',
    fields: [
      'id',
      'app_metadata',
      'provider_identities.id',
      'provider_identities.provider',
      'provider_identities.entity_id',
    ],
    filters: {
      provider_identities: { provider: 'google', entity_id: googleSub },
    },
  })) as { data: AuthIdentity[] }

  if (identities.length === 0) {
    throw new Error(
      `No Google auth identity found for sub ${googleSub}. The owner must complete ` +
      'one "Continue with Google" attempt (which fails at the login page but creates ' +
      'the identity) before binding.',
    )
  }
  if (identities.length > 1) {
    throw new Error(
      `Multiple auth identities match Google sub ${googleSub}; refusing to bind an ambiguous identity.`,
    )
  }

  const target = identities[0]
  const googlePi = target.provider_identities?.find((pi) => pi.provider === 'google')
  if (!googlePi) {
    throw new Error(`Auth identity ${target.id} has no google provider identity; refusing to bind.`)
  }

  const appMetadata = (target.app_metadata ?? {}) as Record<string, unknown>
  const existingUserId = appMetadata.user_id

  if (existingUserId != null) {
    if (existingUserId === adminUserId) {
      console.log(`Google auth identity ${target.id} is already bound to admin user ${adminUserId}; no change.`)
      return
    }
    throw new Error(
      `Google auth identity ${target.id} is already bound to a different user (${String(existingUserId)}). ` +
      'Refusing to rebind.',
    )
  }

  // Official auth module service: write app_metadata.user_id onto the identity.
  await auth.updateAuthIdentities({
    id: target.id,
    app_metadata: { user_id: adminUserId },
  })

  console.log(
    `Bound Google auth identity ${target.id} (sub ${googleSub}) -> admin user ${adminUserId} (${adminEmail}).`,
  )
}
