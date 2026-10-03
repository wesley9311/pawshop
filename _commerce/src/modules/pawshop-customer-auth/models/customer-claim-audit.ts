import { model } from '@medusajs/framework/utils'

// Append-only audit ledger for guest-customer claim (customer account binding).
//
// When a verified customer registers with an email that already has a
// `has_account=false` guest customer (auto-created at checkout), the registration
// must UPGRADE that guest customer in place (set has_account=true + bind the
// auth identity) rather than create a duplicate. Every such binding — whether it
// upgraded a guest or created a brand-new account — is recorded here exactly once
// so the linkage is auditable after the fact.
//
// Invariants:
//   - append-only: rows are inserted and never updated or deleted.
//   - idempotent: the unique index on `auth_identity_id` guarantees one row per
//     auth identity, so a replayed registration cannot double-record a claim.
//   - non-sensitive: no verification code, no token, no password, no email body
//     is ever stored. `email` is retained only as a non-secret audit locator.
export const CustomerClaimAudit = model.define('CustomerClaimAudit', {
  id: model.id({ prefix: 'custclaim' }).primaryKey(),
  customer_id: model.text(),
  auth_identity_id: model.text(),
  email: model.text(),
  claim_kind: model.enum(['new', 'guest_claim']),
  claimed_at: model.dateTime(),
  claimed_by: model.text(),
}).indexes([
  {
    name: 'IDX_customer_claim_audit_auth_identity_unique',
    on: ['auth_identity_id'],
    unique: true,
  },
  {
    name: 'IDX_customer_claim_audit_customer_id',
    on: ['customer_id'],
  },
  {
    name: 'IDX_customer_claim_audit_email',
    on: ['email'],
  },
])
