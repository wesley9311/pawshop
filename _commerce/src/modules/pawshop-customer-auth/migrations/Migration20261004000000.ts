import { Migration } from '@medusajs/framework/mikro-orm/migrations'

// Customer-account claim audit table.
//
// Additive only: one new table and its indexes. No core commerce table is
// altered, renamed or dropped, so this migration is reversible and independent
// of the commerce schema. `deleted_at` is an implicit property of every Medusa
// DML model, which is why the table carries it and the unique index is partial
// on `deleted_at is null`.
export class Migration20261004000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      'create table if not exists "customer_claim_audit" (' +
        '"id" text not null, ' +
        '"customer_id" text not null, ' +
        '"auth_identity_id" text not null, ' +
        '"email" text not null, ' +
        '"claim_kind" text not null, ' +
        '"claimed_at" timestamptz not null, ' +
        '"claimed_by" text not null, ' +
        '"created_at" timestamptz not null default now(), ' +
        '"updated_at" timestamptz not null default now(), ' +
        '"deleted_at" timestamptz null, ' +
        'constraint "customer_claim_audit_pkey" primary key ("id")' +
      ');'
    )
    this.addSql(
      'create unique index if not exists "IDX_customer_claim_audit_auth_identity_unique" ' +
        'on "customer_claim_audit" ("auth_identity_id") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_customer_claim_audit_customer_id" ' +
        'on "customer_claim_audit" ("customer_id") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_customer_claim_audit_email" ' +
        'on "customer_claim_audit" ("email") where "deleted_at" is null;'
    )
    this.addSql(
      'create table if not exists "verification_rate" (' +
        '"id" text not null, ' +
        '"scope" text not null, ' +
        '"scope_key" text not null, ' +
        '"requested_at" timestamptz not null, ' +
        '"created_at" timestamptz not null default now(), ' +
        '"updated_at" timestamptz not null default now(), ' +
        '"deleted_at" timestamptz null, ' +
        'constraint "verification_rate_pkey" primary key ("id")' +
      ');'
    )
    this.addSql(
      'create index if not exists "IDX_verification_rate_scope_key_time" ' +
        'on "verification_rate" ("scope", "scope_key", "requested_at") where "deleted_at" is null;'
    )
  }

  async down(): Promise<void> {
    this.addSql('drop table if exists "verification_rate" cascade;')
    this.addSql('drop table if exists "customer_claim_audit" cascade;')
  }
}
