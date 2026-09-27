import { Migration } from '@medusajs/framework/mikro-orm/migrations'

// Tables owned by the PawShop Connector module.
//
// Additive only: four new tables and their indexes. No core commerce table is
// altered, renamed or dropped, so this migration is reversible and independent
// of the commerce schema. `deleted_at` is an implicit property of every Medusa
// DML model, which is why every table carries it and every unique index is
// partial on `deleted_at is null`.
export class Migration20260927120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      'create table if not exists "connector_product_mapping" (' +
        '"id" text not null, ' +
        '"source_product_id" text not null, ' +
        '"product_id" text not null, ' +
        '"handle" text null, ' +
        '"last_revision" integer null, ' +
        '"external_version" text null, ' +
        '"created_at" timestamptz not null default now(), ' +
        '"updated_at" timestamptz not null default now(), ' +
        '"deleted_at" timestamptz null, ' +
        'constraint "connector_product_mapping_pkey" primary key ("id")' +
      ');'
    )
    this.addSql(
      'create unique index if not exists "IDX_connector_product_mapping_source_product_id_unique" ' +
        'on "connector_product_mapping" ("source_product_id") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_connector_product_mapping_product_id" ' +
        'on "connector_product_mapping" ("product_id") where "deleted_at" is null;'
    )

    this.addSql(
      'create table if not exists "connector_idempotency_record" (' +
        '"id" text not null, ' +
        '"idempotency_key" text not null, ' +
        '"key_id" text not null, ' +
        '"source_product_id" text not null, ' +
        '"product_id" text not null, ' +
        '"response_status" integer not null, ' +
        '"response_body" jsonb not null, ' +
        '"request_body_sha256" text not null, ' +
        '"expires_at" timestamptz not null, ' +
        '"created_at" timestamptz not null default now(), ' +
        '"updated_at" timestamptz not null default now(), ' +
        '"deleted_at" timestamptz null, ' +
        'constraint "connector_idempotency_record_pkey" primary key ("id")' +
      ');'
    )
    this.addSql(
      'create unique index if not exists "IDX_connector_idempotency_record_key_unique" ' +
        'on "connector_idempotency_record" ("idempotency_key") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_connector_idempotency_record_expires_at" ' +
        'on "connector_idempotency_record" ("expires_at") where "deleted_at" is null;'
    )

    this.addSql(
      'create table if not exists "connector_replay_nonce" (' +
        '"id" text not null, ' +
        '"key_id" text not null, ' +
        '"nonce" text not null, ' +
        '"claimed_at" timestamptz not null, ' +
        '"expires_at" timestamptz not null, ' +
        '"created_at" timestamptz not null default now(), ' +
        '"updated_at" timestamptz not null default now(), ' +
        '"deleted_at" timestamptz null, ' +
        'constraint "connector_replay_nonce_pkey" primary key ("id")' +
      ');'
    )
    this.addSql(
      'create unique index if not exists "IDX_connector_replay_nonce_key_unique" ' +
        'on "connector_replay_nonce" ("key_id", "nonce") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_connector_replay_nonce_expires_at" ' +
        'on "connector_replay_nonce" ("expires_at") where "deleted_at" is null;'
    )

    this.addSql(
      'create table if not exists "connector_audit_event" (' +
        '"id" text not null, ' +
        '"occurred_at" timestamptz not null, ' +
        '"method" text not null, ' +
        '"path" text not null, ' +
        '"key_id" text null, ' +
        '"key_version" text null, ' +
        '"source_product_id" text null, ' +
        '"product_id" text null, ' +
        '"idempotency_key" text null, ' +
        '"request_body_sha256" text null, ' +
        '"outcome" text not null, ' +
        '"http_status" integer not null, ' +
        '"error_code" text null, ' +
        '"duration_ms" integer null, ' +
        '"detail" jsonb null, ' +
        '"created_at" timestamptz not null default now(), ' +
        '"updated_at" timestamptz not null default now(), ' +
        '"deleted_at" timestamptz null, ' +
        'constraint "connector_audit_event_pkey" primary key ("id")' +
      ');'
    )
    this.addSql(
      'create index if not exists "IDX_connector_audit_event_occurred_at" ' +
        'on "connector_audit_event" ("occurred_at") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_connector_audit_event_source_product_id" ' +
        'on "connector_audit_event" ("source_product_id") where "deleted_at" is null;'
    )
    this.addSql(
      'create index if not exists "IDX_connector_audit_event_idempotency_key" ' +
        'on "connector_audit_event" ("idempotency_key") where "deleted_at" is null;'
    )
  }

  async down(): Promise<void> {
    this.addSql('drop table if exists "connector_audit_event" cascade;')
    this.addSql('drop table if exists "connector_replay_nonce" cascade;')
    this.addSql('drop table if exists "connector_idempotency_record" cascade;')
    this.addSql('drop table if exists "connector_product_mapping" cascade;')
  }
}
