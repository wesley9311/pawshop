import type { MedusaStoreRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  createCustomerAccountWorkflow,
  setAuthAppMetadataWorkflow,
} from '@medusajs/core-flows'
import { commerceIsOpen } from '../../../lib/production-modes.cjs'
import { normalizeEmail, isClaimableEmail, decideClaim } from '../../../lib/customer-claim.cjs'

// Customer registration with guest-claim.
//
// This overrides Medusa's stock `POST /store/customers`. The stock route blindly
// runs `createCustomerAccountWorkflow`, which creates a NEW customer row even when
// a `has_account=false` guest customer already exists for the email — leaving the
// guest row (with its historical orders) orphaned. Medusa's own unique index on
// `customer(email, has_account)` makes that split visible and wrong.
//
// This route instead decides by email:
//   - no existing customer            → create a fresh account (stock workflow)
//   - one guest customer              → CLAIM: upgrade that customer in place
//   - one account customer            → already registered, return it (idempotent)
//   - >1 customer for the email       → stop, report; never auto-merge
//
// Authorization: the identity is the auth_identity_id resolved from the actorless
// registration token by Medusa's own authenticate middleware — the route never
// reads a customer_id from the request body or query. Claim only ever touches
// `customer.has_account` + the auth identity's app_metadata; it never alters any
// order or item snapshot.
//
// Verification gate: a claim (guest→account) is only allowed when Medusa's auth
// module attests the email is verified (a `verification` row with non-null
// `verified_at`). The route never trusts a client flag, the request email, or the
// mere presence of a registration token.

type CustomerRow = { id: string; has_account: boolean }

type PawshopCustomerAuth = {
  claimGuestCustomer: (customerId: string) => Promise<boolean>
  recordClaim: (input: {
    customerId: string
    authIdentityId: string
    email: string
    claimKind: 'new' | 'guest_claim'
    now: Date
  }) => Promise<boolean>
}

export async function POST(req: MedusaStoreRequest, res: MedusaResponse) {
  if (!commerceIsOpen(process.env.PAWSHOP_MODE)) {
    return res.status(503).json({ type: 'not_allowed', message: 'PawShop storefront APIs are not open.' })
  }

  // The auth context is present because the middleware authenticates with
  // allowUnregistered. An already-authenticated customer (actor_id set) must not
  // register again.
  const authContext = req.auth_context as
    | { actor_id?: string; auth_identity_id?: string }
    | undefined
  if (authContext?.actor_id) {
    return res.status(400).json({ type: 'invalid_data', message: 'Request already authenticated as a customer.' })
  }
  const authIdentityId = authContext?.auth_identity_id
  if (!authIdentityId) {
    return res.status(401).json({ type: 'unauthorized', message: 'Registration requires a valid registration token.' })
  }

  const body = (req.body || {}) as { email?: string | null; first_name?: string | null; last_name?: string | null }
  const email = normalizeEmail(body.email || '')
  if (!isClaimableEmail(email)) {
    return res.status(400).json({ type: 'invalid_data', message: 'A valid email is required.' })
  }

  const customerService = req.scope.resolve(Modules.CUSTOMER) as {
    listCustomers: (filters: Record<string, unknown>, config: unknown) => Promise<CustomerRow[]>
  }
  const pawshopCustomerAuth = (req.scope as any).resolve('pawshopCustomerAuth') as PawshopCustomerAuth

  const existing = await customerService.listCustomers({ email }, {})

  const decision = decideClaim(existing)

  let customerId: string
  let claimKind: 'new' | 'guest_claim'

  if (decision.kind === 'conflict') {
    return res.status(409).json({
      type: 'conflict',
      message: 'This email is associated with multiple accounts and cannot be claimed automatically.',
    })
  }

  if (decision.kind === 'already_claimed') {
    // Idempotent: the account already exists for this email. No new customer is
    // created and no audit row is written. The binding below re-affirms the same
    // value (a no-op).
    customerId = decision.customerId
    claimKind = 'guest_claim'
  } else if (decision.kind === 'claim') {
    // CLAIM: upgrade the existing guest customer in place. The atomic flip lives
    // in the customer-auth service (correct PG access via the module container),
    // not on the request scope. The WHERE guard `has_account = false` makes it
    // concurrency-safe: a concurrent second claim updates zero rows.
    //
    // Verified-email gate: a guest→account claim may only proceed when Medusa's
    // auth module attests the email is verified (a `verification` row for this
    // identity + entity_id + entity_type with non-null `verified_at`). This is
    // the authoritative server-side state — never a client flag, never the
    // request email, never mere token presence.
    const authService = req.scope.resolve(Modules.AUTH) as {
      listAuthVerifications: (filters: Record<string, unknown>) => Promise<Array<{ verified_at?: Date | null }>>
    }
    const verifications = await authService.listAuthVerifications({
      auth_identity_id: authIdentityId,
      entity_id: email,
      entity_type: 'customer',
    })
    const verified = verifications.some((v) => v.verified_at != null)
    if (!verified) {
      return res.status(403).json({
        type: 'unverified',
        message: 'Email must be verified before this account can be claimed.',
      })
    }
    customerId = decision.customerId
    claimKind = 'guest_claim'
    await pawshopCustomerAuth.claimGuestCustomer(customerId)
    if (body.first_name || body.last_name) {
      await (customerService as any).updateCustomers({
        id: customerId,
        ...(body.first_name ? { first_name: body.first_name } : {}),
        ...(body.last_name ? { last_name: body.last_name } : {}),
      })
    }
  } else {
    // create: no existing customer. Run the stock account-creation workflow, which
    // creates the customer with has_account=true AND binds the auth identity
    // (setAuthAppMetadataStep inside). Do NOT bind again here — a second
    // setAuthAppMetadataWorkflow throws "Key customer_id already exists".
    const { result } = await createCustomerAccountWorkflow(req.scope).run({
      input: {
        authIdentityId,
        customerData: {
          email,
          ...(body.first_name ? { first_name: body.first_name } : {}),
          ...(body.last_name ? { last_name: body.last_name } : {}),
        },
      },
    })
    customerId = (result as { id: string }).id
    claimKind = 'new'
  }

  // Bind the auth identity to the customer ONLY for the claim / already_claimed
  // paths (the create path was already bound by the stock workflow). The binding
  // throws when the key already exists with a *different* value — which must not
  // be silently overwritten.
  if (claimKind === 'guest_claim') {
    await setAuthAppMetadataWorkflow(req.scope).run({
      input: {
        authIdentityId,
        actorType: 'customer',
        value: customerId,
      },
    })
  }

  // Record the claim in the append-only audit ledger. Idempotent on auth_identity_id.
  await pawshopCustomerAuth.recordClaim({
    customerId,
    authIdentityId,
    email,
    claimKind,
    now: new Date(),
  }).catch(() => undefined) // audit failure must not break registration

  // Re-fetch the customer through the remote query to return the expected shape.
  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY) as (
    query: unknown,
  ) => Promise<Array<Record<string, unknown>>>
  const customers = await remoteQuery({
    entryPoint: 'customer',
    variables: { filters: { id: customerId } },
    fields: ['id', 'email', 'first_name', 'last_name', 'has_account'],
  })
  const customer = customers[0]

  return res.status(200).json({ customer })
}
