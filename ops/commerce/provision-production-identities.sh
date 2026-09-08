#!/usr/bin/env bash
set +x
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root to provision PawShop production identities.' >&2
  exit 1
fi

for required_command in openssl psql dropdb runuser systemctl ss install stat getent redis-cli sha256sum awk grep rm rmdir cmp mv id mktemp chmod chown sed cut date sort flock; do
  command -v "$required_command" >/dev/null || {
    echo "Required production command is unavailable: $required_command" >&2
    exit 1
  }
done

for service in postgresql@17-main.service redis-server.service; do
  systemctl is-active --quiet "$service" || {
    echo "Required private data service is not active: $service" >&2
    exit 1
  }
done

actual_listeners=$(ss -lntH | awk '$4 ~ /:(5432|6379)$/ { print $4 }' | sort -u)
expected_listeners=$'127.0.0.1:5432\n127.0.0.1:6379'
if [[ $actual_listeners != "$expected_listeners" ]]; then
  echo 'PostgreSQL and Redis must be restricted to the approved loopback listeners.' >&2
  exit 1
fi

validate_system_account() {
  local name=$1 expected_home=$2
  local entry user uid gid actual_home shell group_entry primary_group group_members all_groups
  entry=$(getent passwd "$name") || {
    echo "Required PawShop system account is missing: $name" >&2
    exit 1
  }
  IFS=: read -r user _ uid gid _ actual_home shell <<<"$entry"
  group_entry=$(getent group "$gid") || {
    echo "Required PawShop private group is missing: $name" >&2
    exit 1
  }
  IFS=: read -r primary_group _ _ group_members <<<"$group_entry"
  all_groups=$(id -Gn "$name")
  if [[ $user != "$name" || ! $uid =~ ^[0-9]+$ || $uid -le 0 || $uid -ge 1000 ||
        ! $gid =~ ^[0-9]+$ || $gid -le 0 || $gid -ge 1000 ||
        $primary_group != "$name" || -n $group_members || $all_groups != "$name" ||
        $actual_home != "$expected_home" || $shell != /usr/sbin/nologin ]]; then
    echo "PawShop system account no longer matches its private identity contract: $name" >&2
    exit 1
  fi
  if getent passwd | awk -F: -v expected_user="$name" -v expected_gid="$gid" \
    '$4 == expected_gid && $1 != expected_user { found=1 } END { exit !found }'; then
    echo "The PawShop private group is shared by another account: $name" >&2
    exit 1
  fi
}
validate_system_account pawshop /var/lib/pawshop
validate_system_account pawshop-backup /nonexistent

validate_private_directory() {
  local path=$1 expected_owner=$2 expected_group=$3 expected_mode=$4
  if [[ ! -d $path || -L $path ]] ||
     [[ $(stat -c '%U:%G:%a' -- "$path") != "$expected_owner:$expected_group:$expected_mode" ]]; then
    echo "A PawShop private directory no longer matches its ownership contract: $path" >&2
    exit 1
  fi
}
validate_private_directory /etc/pawshop root pawshop 750
validate_private_directory /etc/pawshop-backup root pawshop-backup 750
validate_private_directory /var/backups/pawshop pawshop-backup pawshop-backup 700

marker=/etc/pawshop/.production-identities-provisioned
internal_secrets=/etc/pawshop/internal-secrets.env
backup_env=/etc/pawshop-backup/backup.env
backup_key=/etc/pawshop-backup/backup.key
owner_credentials=/root/pawshop-production-owner-credentials.txt
redis_acl_dir=/etc/pawshop-redis
redis_acl=/etc/pawshop-redis/users.acl
redis_dropin=/etc/systemd/system/redis-server.service.d/pawshop.conf
lock_file=/run/lock/pawshop-production-identities.lock

exec 9>"$lock_file"
flock -n 9 || {
  echo 'Another PawShop production identity operation is active.' >&2
  exit 1
}

if [[ ! -f $redis_dropin || -L $redis_dropin ]] ||
   [[ $(stat -c '%U:%G:%a' -- "$redis_dropin") != 'root:root:644' ]]; then
  echo 'The reviewed Redis service drop-in is missing or has unsafe ownership.' >&2
  exit 1
fi
for path in "$marker" "$internal_secrets" "$backup_env" "$backup_key" "$owner_credentials" "$redis_acl_dir"; do
  if [[ -e $path || -L $path ]]; then
    echo "Existing production identity artifact requires an explicit recovery review: $path" >&2
    exit 1
  fi
done

existing_roles=$(runuser -u postgres -- psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('pawshop', 'pawshop_backup')") || {
  echo 'Could not verify the PostgreSQL role baseline.' >&2
  exit 1
}
existing_database=$(runuser -u postgres -- psql --no-psqlrc --tuples-only --no-align --command \
  "SELECT count(*) FROM pg_database WHERE datname = 'pawshop'") || {
  echo 'Could not verify the PostgreSQL database baseline.' >&2
  exit 1
}
if [[ $existing_roles != 0 || $existing_database != 0 ]]; then
  echo 'A PawShop PostgreSQL database or role already exists; refusing to rotate credentials implicitly.' >&2
  exit 1
fi

work_dir=$(mktemp -d /var/tmp/pawshop-identities.XXXXXXXX)
chmod 0700 "$work_dir"
install -o root -g root -m 0600 "$redis_dropin" "$work_dir/redis-dropin.original"
baseline_redis=$(redis-cli --host 127.0.0.1 --port 6379 PING 2>&1) || {
  echo 'Redis did not provide the expected pre-provisioning baseline.' >&2
  rm -rf -- "$work_dir"
  exit 1
}
if [[ $baseline_redis != PONG ]]; then
  echo 'Redis is not in the reviewed unauthenticated pre-provisioning state.' >&2
  rm -rf -- "$work_dir"
  exit 1
fi
database_created=0
app_role_created=0
backup_role_created=0
redis_mutation_started=0
completed=0

cleanup() {
  local status=$? containment_failed=0 recovery_dir=
  trap - EXIT INT TERM
  set +e
  if [[ $completed != 1 ]]; then
    if [[ $redis_mutation_started == 1 ]] || ! cmp -s -- "$work_dir/redis-dropin.original" "$redis_dropin"; then
      install -o root -g root -m 0644 "$work_dir/redis-dropin.original" "$redis_dropin" || containment_failed=1
      systemctl daemon-reload || containment_failed=1
      systemctl restart redis-server.service || containment_failed=1
      systemctl is-active --quiet redis-server.service || containment_failed=1
      cmp -s -- "$work_dir/redis-dropin.original" "$redis_dropin" || containment_failed=1
      restored_redis=$(redis-cli --host 127.0.0.1 --port 6379 PING 2>&1)
      [[ $restored_redis == PONG ]] || containment_failed=1
    fi
    if [[ $database_created == 1 ]]; then
      runuser -u postgres -- dropdb --if-exists --force pawshop >/dev/null 2>&1 || containment_failed=1
    fi
    if [[ $backup_role_created == 1 ]]; then
      runuser -u postgres -- psql --no-psqlrc --quiet --command \
        'DROP ROLE IF EXISTS pawshop_backup;' >/dev/null 2>&1 || containment_failed=1
    fi
    if [[ $app_role_created == 1 ]]; then
      runuser -u postgres -- psql --no-psqlrc --quiet --command \
        'DROP ROLE IF EXISTS pawshop;' >/dev/null 2>&1 || containment_failed=1
    fi
    roles_remaining=$(runuser -u postgres -- psql --no-psqlrc --tuples-only --no-align --command \
      "SELECT count(*) FROM pg_roles WHERE rolname IN ('pawshop', 'pawshop_backup')") || containment_failed=1
    database_remaining=$(runuser -u postgres -- psql --no-psqlrc --tuples-only --no-align --command \
      "SELECT count(*) FROM pg_database WHERE datname = 'pawshop'") || containment_failed=1
    [[ $roles_remaining == 0 && $database_remaining == 0 ]] || containment_failed=1
    if [[ $containment_failed == 0 ]]; then
      rm -f -- "$marker" "$internal_secrets" "$backup_env" "$backup_key" "$owner_credentials" "$redis_acl" || containment_failed=1
      if [[ -e $redis_acl_dir || -L $redis_acl_dir ]]; then
        rmdir -- "$redis_acl_dir" || containment_failed=1
      fi
    fi
    if [[ $containment_failed != 0 ]]; then
      recovery_dir="/root/pawshop-identity-recovery-$(date -u +'%Y%m%dT%H%M%SZ')-$$"
      mv -- "$work_dir" "$recovery_dir" || recovery_dir="$work_dir"
      chmod 0700 "$recovery_dir" 2>/dev/null || true
      echo "CRITICAL: identity rollback could not be verified; root-only recovery material was preserved at $recovery_dir" >&2
      exit 1
    fi
  fi
  rm -rf -- "$work_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

app_password=$(openssl rand -hex 32)
backup_password=$(openssl rand -hex 32)
redis_password=$(openssl rand -hex 32)
jwt_secret=$(openssl rand -hex 32)
cookie_secret=$(openssl rand -hex 32)
backup_key_value=$(openssl rand -hex 32)

cat > "$work_dir/recovery-secrets.txt" <<EOF
app_password=$app_password
backup_password=$backup_password
redis_password=$redis_password
jwt_secret=$jwt_secret
cookie_secret=$cookie_secret
backup_key=$backup_key_value
EOF
chmod 0600 "$work_dir/recovery-secrets.txt"

cat > "$work_dir/create-app-role.sql" <<EOF
CREATE ROLE pawshop LOGIN PASSWORD '$app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
EOF
cat > "$work_dir/create-backup-role.sql" <<EOF
CREATE ROLE pawshop_backup LOGIN PASSWORD '$backup_password' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION;
EOF
cat > "$work_dir/create-database.sql" <<'EOF'
CREATE DATABASE pawshop OWNER pawshop TEMPLATE template0 ENCODING 'UTF8';
EOF
cat > "$work_dir/configure-database.sql" <<'EOF'
\\connect pawshop
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE pawshop TO pawshop_backup;
GRANT USAGE ON SCHEMA public TO pawshop_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pawshop_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO pawshop_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE pawshop IN SCHEMA public GRANT SELECT ON TABLES TO pawshop_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE pawshop IN SCHEMA public GRANT SELECT ON SEQUENCES TO pawshop_backup;
EOF
chmod 0600 "$work_dir"/*.sql

run_postgres_sql() {
  local sql_file=$1
  runuser -u postgres -- psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 < "$sql_file" >/dev/null
}
run_postgres_sql "$work_dir/create-app-role.sql" || {
  echo 'PostgreSQL application role creation had an indeterminate result; recovery evidence will be preserved.' >&2
  exit 1
}
app_role_created=1
run_postgres_sql "$work_dir/create-backup-role.sql" || {
  echo 'PostgreSQL backup role creation had an indeterminate result; recovery evidence will be preserved.' >&2
  exit 1
}
backup_role_created=1
run_postgres_sql "$work_dir/create-database.sql" || {
  echo 'PostgreSQL database creation had an indeterminate result; recovery evidence will be preserved.' >&2
  exit 1
}
database_created=1
run_postgres_sql "$work_dir/configure-database.sql" || {
  echo 'PostgreSQL database grants failed; confirmed objects will be removed.' >&2
  exit 1
}

PGPASSWORD="$app_password" psql --no-psqlrc --host 127.0.0.1 --port 5432 \
  --username pawshop --dbname pawshop --tuples-only --no-align --command 'SELECT 1' | grep -qx 1
PGPASSWORD="$backup_password" psql --no-psqlrc --host 127.0.0.1 --port 5432 \
  --username pawshop_backup --dbname pawshop --tuples-only --no-align --command 'SELECT 1' | grep -qx 1

redis_password_hash=$(printf '%s' "$redis_password" | sha256sum | awk '{print $1}')
cat > "$work_dir/pawshop-users.acl" <<EOF
user default off
user pawshop on #$redis_password_hash ~* &* +@all -acl -config -debug -shutdown -flushall -flushdb -module -save -bgsave -bgrewriteaof -replicaof -slaveof
EOF
install -d -o root -g redis -m 0750 "$redis_acl_dir"
install -o root -g redis -m 0640 "$work_dir/pawshop-users.acl" "$redis_acl"
if grep -q -- '--aclfile' "$redis_dropin"; then
  echo 'The Redis service already has an unmanaged ACL file argument.' >&2
  exit 1
fi
sed 's# --maxmemory 96mb# --aclfile /etc/pawshop-redis/users.acl --maxmemory 96mb#' \
  "$redis_dropin" > "$work_dir/redis-dropin.updated"
if ! grep -q -- '--aclfile /etc/pawshop-redis/users.acl' "$work_dir/redis-dropin.updated"; then
  echo 'The reviewed Redis service command no longer matches the provisioning contract.' >&2
  exit 1
fi
redis_mutation_started=1
install -o root -g root -m 0644 "$work_dir/redis-dropin.updated" "$redis_dropin"
systemctl daemon-reload
systemctl restart redis-server.service
systemctl is-active --quiet redis-server.service
anonymous_redis_status=0
anonymous_redis=$(redis-cli --host 127.0.0.1 --port 6379 PING 2>&1) || anonymous_redis_status=$?
if (( anonymous_redis_status > 1 )) ||
   [[ $anonymous_redis != 'NOAUTH Authentication required.' &&
      $anonymous_redis != '(error) NOAUTH Authentication required.' ]]; then
  echo 'Redis did not return the exact reviewed anonymous-authentication denial.' >&2
  exit 1
fi
[[ $anonymous_redis != *PONG* ]] || { echo 'Redis still accepts an unauthenticated request.' >&2; exit 1; }
REDISCLI_AUTH="$redis_password" redis-cli --no-auth-warning --host 127.0.0.1 --port 6379 \
  --user pawshop PING | grep -qx PONG

cat > "$work_dir/internal-secrets.env" <<EOF
DATABASE_URL=postgresql://pawshop:$app_password@127.0.0.1:5432/pawshop?sslmode=disable
REDIS_URL=redis://pawshop:$redis_password@127.0.0.1:6379
JWT_SECRET=$jwt_secret
COOKIE_SECRET=$cookie_secret
EOF
install -o root -g pawshop -m 0640 "$work_dir/internal-secrets.env" "$internal_secrets"

cat > "$work_dir/backup.env" <<EOF
NODE_ENV=production
PAWSHOP_MODE=production-admin-only
PAWSHOP_INFRA_TOPOLOGY=single-host-private
DATABASE_URL=postgresql://pawshop_backup:$backup_password@127.0.0.1:5432/pawshop?sslmode=disable
PAWSHOP_BACKUP_DIR=/var/backups/pawshop
PAWSHOP_BACKUP_KEY_FILE=/etc/pawshop-backup/backup.key
EOF
install -o root -g pawshop-backup -m 0640 "$work_dir/backup.env" "$backup_env"
printf '%s\n' "$backup_key_value" > "$work_dir/backup.key"
install -o root -g pawshop-backup -m 0640 "$work_dir/backup.key" "$backup_key"

cat > "$work_dir/owner-credentials.txt" <<EOF
PawLivora / PawShop production credentials
Generated: $(date -u +'%Y-%m-%dT%H:%M:%SZ')
Host: 47.254.26.124

PostgreSQL application account
Username: pawshop
Password: $app_password
Database: pawshop
Connection: postgresql://pawshop:$app_password@127.0.0.1:5432/pawshop?sslmode=disable

PostgreSQL backup account
Username: pawshop_backup
Password: $backup_password
Database: pawshop
Connection: postgresql://pawshop_backup:$backup_password@127.0.0.1:5432/pawshop?sslmode=disable

Redis application account
Username: pawshop
Password: $redis_password
Connection: redis://pawshop:$redis_password@127.0.0.1:6379

Medusa service secrets
JWT_SECRET: $jwt_secret
COOKIE_SECRET: $cookie_secret

Database backup encryption key
BACKUP_KEY: $backup_key_value

OSS
Bucket: pawlivora-products-us-west-1
Region: oss-us-west-1
Endpoint: https://oss-us-west-1.aliyuncs.com
RAM user/access key: PENDING - RAM console content service was unavailable during provisioning.

Security notes
- This file is root-readable only. Never paste it into chat, GitHub, source code, or screenshots.
- PostgreSQL and Redis accept connections only from 127.0.0.1.
- Rotate a credential through a reviewed coordinated procedure; do not edit only one copy.
EOF
install -o root -g root -m 0600 "$work_dir/owner-credentials.txt" "$owner_credentials"
printf '%s\n' "provisioned_at=$(date -u +'%Y-%m-%dT%H:%M:%SZ')" > "$work_dir/marker"
install -o root -g root -m 0600 "$work_dir/marker" "$marker"

for expectation in \
  "$internal_secrets:0:$(getent group pawshop | cut -d: -f3):640" \
  "$backup_env:0:$(getent group pawshop-backup | cut -d: -f3):640" \
  "$backup_key:0:$(getent group pawshop-backup | cut -d: -f3):640" \
  "$owner_credentials:0:0:600" \
  "$redis_acl:0:$(getent group redis | cut -d: -f3):640"; do
  IFS=: read -r path expected_uid expected_gid expected_mode <<<"$expectation"
  [[ $(stat -c '%u:%g:%a' -- "$path") == "$expected_uid:$expected_gid:$expected_mode" ]] || {
    echo "A production credential file has unsafe ownership or mode: $path" >&2
    exit 1
  }
done
[[ $(stat -c '%U:%G:%a' -- "$redis_acl_dir") == 'root:redis:750' ]] || {
  echo 'The Redis ACL directory has unsafe ownership or mode.' >&2
  exit 1
}

completed=1
echo 'PawShop production database and Redis identities were provisioned and verified.'
echo 'Owner credential handoff: /root/pawshop-production-owner-credentials.txt (mode 0600)'
echo 'OSS RAM access credentials remain pending; commerce.env and Medusa stay inactive.'
