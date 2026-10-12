import { Migration } from '@medusajs/framework/mikro-orm/migrations'

// Additive reconciliation ledger only. Core payment/order tables are unchanged.
export class Migration20261011000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      'create table if not exists "payment_reconciliation" (' +
        '"id" text not null, ' +
        '"provider_event_id" text not null, ' +
        '"external_id" text not null, ' +
        '"event_type" text check ("event_type" in (\'refund\', \'reversal\')) not null, ' +
        '"capture_id" text null, ' +
        '"payment_id" text null, ' +
        '"order_id" text null, ' +
        '"amount" text null, ' +
        '"currency_code" text null, ' +
        '"status" text check ("status" in (\'received\', \'applied\', \'review\')) not null, ' +
        '"reason" text null, ' +
        '"resolved_at" timestamptz null, ' +
        '"created_at" timestamptz not null default now(), ' +
        '"updated_at" timestamptz not null default now(), ' +
        '"deleted_at" timestamptz null, ' +
        'constraint "payment_reconciliation_pkey" primary key ("id")' +
      ');'
    )
    this.addSql('create unique index if not exists "IDX_payment_reconciliation_provider_event_unique" on "payment_reconciliation" ("provider_event_id") where "deleted_at" is null;')
    this.addSql('create unique index if not exists "IDX_payment_reconciliation_external_id" on "payment_reconciliation" ("external_id") where "deleted_at" is null;')
    this.addSql('create index if not exists "IDX_payment_reconciliation_order_status" on "payment_reconciliation" ("order_id", "status") where "deleted_at" is null;')
  }

  async down(): Promise<void> {
    this.addSql('drop table if exists "payment_reconciliation" cascade;')
  }
}
