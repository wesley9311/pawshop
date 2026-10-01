import { Migration } from '@medusajs/framework/mikro-orm/migrations'

// The send-state-machine table for customer transactional email.
//
// Additive only: one new table and its indexes. No core commerce table is
// altered, renamed or dropped, so this migration is reversible and independent
// of the commerce schema. `deleted_at` is an implicit property of every Medusa
// DML model, which is why the table carries it and the unique index is partial
// on `deleted_at is null`.
export class Migration20261001010000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      'create table if not exists "transactional_email_sent" (' +
        '"id" text not null, ' +
        '"idempotency_key" text not null, ' +
        '"notification_type" text not null, ' +
        '"entity_id" text not null, ' +
        '"status" text not null, ' +
        '"attempt_count" integer not null default 0, ' +
        '"claimed_at" timestamptz null, ' +
        '"lease_expires_at" timestamptz null, ' +
        '"next_attempt_at" timestamptz null, ' +
        '"sent_at" timestamptz null, ' +
        '"error_category" text null, ' +
        '"expires_at" timestamptz not null, ' +
        '"created_at" timestamptz not null default now(), ' +
        '"updated_at" timestamptz not null default now(), ' +
        '"deleted_at" timestamptz null, ' +
        'constraint "transactional_email_sent_pkey" primary key ("id")' +
      ');'
    )
    this.addSql(
      'create unique index if not exists "IDX_transactional_email_sent_key_unique" ' +
        'on "transactional_email_sent" ("idempotency_key") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_transactional_email_sent_status" ' +
        'on "transactional_email_sent" ("status") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_transactional_email_sent_lease_expires_at" ' +
        'on "transactional_email_sent" ("lease_expires_at") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_transactional_email_sent_next_attempt_at" ' +
        'on "transactional_email_sent" ("next_attempt_at") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_transactional_email_sent_expires_at" ' +
        'on "transactional_email_sent" ("expires_at") where "deleted_at" is null;'
    )
  }

  async down(): Promise<void> {
    this.addSql('drop table if exists "transactional_email_sent" cascade;')
  }
}
