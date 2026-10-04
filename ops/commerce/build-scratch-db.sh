#!/usr/bin/env bash
set -Eeuo pipefail

# Build an isolated scratch database for loopback security validation of a
# customer-auth candidate, WITHOUT touching the production database.
#
# Inputs:
#   PAWSHOP_SCRATCH_DB        (default pawshop_looptest)  target scratch DB name
#   PAWSHOP_PREUPGRADE_BACKUP (required)                  path to the pre-upgrade
#                                                         encrypted .dump.enc
#
# Steps:
#   1. Decrypt the pre-upgrade backup with the backup key.
#   2. Drop (if present) and create the scratch DB.
#   3. pg_restore --no-owner --no-acl into it.
#   4. Re-own every public table + sequence to the pawshop service role.
#   5. Manually apply the customer-auth migration SQL (the two additive tables),
#      bypassing `db:migrate` which would trip over the search module's
#      migration runner against an already-restored tracking table.
#   6. Insert a `Migration20261004000000` row into mikro_orm_migrations so the
#      runtime believes the customer-auth module is already migrated.
#
# The production DB is never referenced by name; only the backup file and the
# scratch DB are touched.

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root so the scratch DB restore and re-own run as postgres.' >&2
  exit 1
fi

: "${PAWSHOP_SCRATCH_DB:=pawshop_looptest}"
: "${PAWSHOP_PREUPGRADE_BACKUP:?Set PAWSHOP_PREUPGRADE_BACKUP to the pre-upgrade encrypted dump.}"

if [[ ! -f $PAWSHOP_PREUPGRADE_BACKUP ]]; then
  echo "Pre-upgrade backup not found: $PAWSHOP_PREUPGRADE_BACKUP" >&2
  exit 1
fi

backup_key=/etc/pawshop-backup/backup.key
if [[ ! -f $backup_key ]]; then
  echo 'Backup key missing.' >&2
  exit 1
fi

workdir=$(mktemp -d /tmp/pawshop-scratch.XXXXXX)
trap 'rm -rf -- "$workdir"' EXIT
chmod 0755 "$workdir"

plain="$workdir/pre-upgrade.dump"

echo "==> decrypting pre-upgrade backup"
/usr/bin/openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$backup_key" \
  -in "$PAWSHOP_PREUPGRADE_BACKUP" -out "$plain"
chmod 0644 "$plain"

echo "==> dropping any existing scratch DB $PAWSHOP_SCRATCH_DB"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
  "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$PAWSHOP_SCRATCH_DB';" >/dev/null 2>&1 || true
sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
  "drop database if exists \"$PAWSHOP_SCRATCH_DB\";" >/dev/null

echo "==> creating scratch DB $PAWSHOP_SCRATCH_DB"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
  "create database \"$PAWSHOP_SCRATCH_DB\" owner pawshop;" >/dev/null

echo "==> restoring into scratch DB"
sudo -u postgres /usr/bin/pg_restore --no-owner --no-acl --dbname "$PAWSHOP_SCRATCH_DB" "$plain"

echo "==> re-owning public tables + sequences to pawshop"
sudo -u postgres psql -d "$PAWSHOP_SCRATCH_DB" -v ON_ERROR_STOP=1 -c \
  "do \$\$ declare r record; begin
     for r in select tablename from pg_tables where schemaname='public' loop
       execute format('alter table public.%I owner to pawshop', r.tablename);
     end loop;
     for r in select sequence_name from information_schema.sequences where sequence_schema='public' loop
       execute format('alter sequence public.%I owner to pawshop', r.sequence_name);
     end loop;
   end \$\$;" >/dev/null

echo "==> applying customer-auth migration SQL (manual, additive-only)"
sudo -u postgres psql -d "$PAWSHOP_SCRATCH_DB" -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists "customer_claim_audit" (
  "id" text not null,
  "customer_id" text not null,
  "auth_identity_id" text not null,
  "email" text not null,
  "claim_kind" text not null,
  "claimed_at" timestamptz not null,
  "claimed_by" text not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "deleted_at" timestamptz null,
  constraint "customer_claim_audit_pkey" primary key ("id")
);
create unique index if not exists "IDX_customer_claim_audit_auth_identity_unique"
  on "customer_claim_audit" ("auth_identity_id") where "deleted_at" is null;
create index if not exists "IDX_customer_claim_audit_customer_id"
  on "customer_claim_audit" ("customer_id") where "deleted_at" is null;
create index if not exists "IDX_customer_claim_audit_email"
  on "customer_claim_audit" ("email") where "deleted_at" is null;
create table if not exists "verification_rate" (
  "id" text not null,
  "scope" text not null,
  "scope_key" text not null,
  "requested_at" timestamptz not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "deleted_at" timestamptz null,
  constraint "verification_rate_pkey" primary key ("id")
);
create index if not exists "IDX_verification_rate_scope_key_time"
  on "verification_rate" ("scope", "scope_key", "requested_at") where "deleted_at" is null;
SQL

echo "==> re-owning the two new tables to pawshop"
sudo -u postgres psql -d "$PAWSHOP_SCRATCH_DB" -v ON_ERROR_STOP=1 -c \
  "alter table public.customer_claim_audit owner to pawshop; alter table public.verification_rate owner to pawshop;" >/dev/null

echo "==> registering Migration20261004000000 in mikro_orm_migrations"
sudo -u postgres psql -d "$PAWSHOP_SCRATCH_DB" -v ON_ERROR_STOP=1 -c \
  "insert into mikro_orm_migrations (name, executed_at) select 'Migration20261004000000', now() where not exists (select 1 from mikro_orm_migrations where name = 'Migration20261004000000');" >/dev/null

echo "==> verifying scratch DB state"
sudo -u postgres psql -d "$PAWSHOP_SCRATCH_DB" -tAc \
  "select tableowner, count(*) from pg_tables where schemaname='public' group by tableowner;"
sudo -u postgres psql -d "$PAWSHOP_SCRATCH_DB" -tAc \
  "select count(*) as customer_claim_audit_rows from customer_claim_audit;"

echo "SCRATCH_DB_READY=$PAWSHOP_SCRATCH_DB"
