#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root to install the reviewed PawShop host runtime.' >&2
  exit 1
fi

source /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_CODENAME:-} != noble || $(uname -m) != x86_64 ]]; then
  echo 'This bootstrap supports only Ubuntu 24.04 noble on x86_64.' >&2
  exit 1
fi

node_version=22.23.2
node_archive="node-v${node_version}-linux-x64.tar.xz"
node_sha256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
node_root="/opt/pawshop-node/node-v${node_version}-linux-x64"
pgdg_fingerprint=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
work_dir=$(mktemp -d /var/tmp/pawshop-bootstrap.XXXXXXXX)
policy_rc_path=/usr/sbin/policy-rc.d
policy_rc_installed=0
runtime_mutation_started=0
cleanup() {
  local status=$?
  local containment_failed=0 enabled_state unit
  trap - EXIT INT TERM
  if [[ $status -ne 0 && $runtime_mutation_started == 1 ]]; then
    set +e
    for unit in postgresql@17-main.service redis-server.service; do
      if systemctl cat "$unit" >/dev/null 2>&1; then
        systemctl stop "$unit" || containment_failed=1
        systemctl disable "$unit" || containment_failed=1
      fi
      if systemctl is-active --quiet "$unit"; then
        containment_failed=1
      fi
      enabled_state=$(systemctl is-enabled "$unit" 2>/dev/null || true)
      [[ $enabled_state == disabled || $enabled_state == not-found ]] || containment_failed=1
    done
  fi
  if [[ $policy_rc_installed == 1 ]]; then
    rm -f -- "$policy_rc_path" || containment_failed=1
    [[ ! -e $policy_rc_path && ! -L $policy_rc_path ]] || containment_failed=1
    policy_rc_installed=0
  fi
  if [[ $containment_failed == 1 ]]; then
    echo 'CRITICAL: bootstrap failed and PostgreSQL/Redis containment or policy-rc.d removal was not verified.' >&2
    status=1
  fi
  rm -rf -- "$work_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export DEBIAN_FRONTEND=noninteractive
apt-get update

if [[ -e $policy_rc_path || -L $policy_rc_path ]]; then
  echo 'An existing policy-rc.d is present; refusing to replace host package policy.' >&2
  exit 1
fi
cat > "$work_dir/policy-rc.d" <<'EOF'
#!/bin/sh
exit 101
EOF
install -o root -g root -m 0755 "$work_dir/policy-rc.d" "$policy_rc_path"
policy_rc_installed=1
runtime_mutation_started=1
apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssl redis-server xz-utils postgresql-common

install -d -o root -g root -m 0755 /usr/share/postgresql-common/pgdg
curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
  --output "$work_dir/apt.postgresql.org.asc" \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
primary_fingerprints=$(gpg --batch --show-keys --with-colons "$work_dir/apt.postgresql.org.asc" |
  awk -F: '$1 == "pub" { primary=1; next } primary && $1 == "fpr" { print $10; primary=0 }')
if [[ $primary_fingerprints != "$pgdg_fingerprint" ]]; then
  echo 'The PostgreSQL repository signing key fingerprint is unexpected.' >&2
  exit 1
fi
install -o root -g root -m 0644 "$work_dir/apt.postgresql.org.asc" \
  /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
cat > "$work_dir/pgdg.sources" <<'EOF'
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: noble-pgdg
Architectures: amd64
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
EOF
install -o root -g root -m 0644 "$work_dir/pgdg.sources" /etc/apt/sources.list.d/pgdg.sources
apt-get update
apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17
rm -f -- "$policy_rc_path"
if [[ -e $policy_rc_path || -L $policy_rc_path ]]; then
  echo 'The temporary policy-rc.d could not be removed.' >&2
  exit 1
fi
policy_rc_installed=0

curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
  --output "$work_dir/$node_archive" \
  "https://nodejs.org/dist/v${node_version}/${node_archive}"
printf '%s  %s\n' "$node_sha256" "$work_dir/$node_archive" | sha256sum --check --status
install -d -o root -g root -m 0755 /opt/pawshop-node
tar -xJf "$work_dir/$node_archive" -C "$work_dir"
fresh_node_root="$work_dir/node-v${node_version}-linux-x64"
if [[ $("$fresh_node_root/bin/node" --version) != "v${node_version}" ]]; then
  echo 'The verified Node archive does not contain the expected runtime.' >&2
  exit 1
fi
if [[ -e $node_root || -L $node_root ]]; then
  if [[ ! -d $node_root || -L $node_root ]] ||
     find "$node_root" ! -type l \( ! -user root -o -perm /022 \) -print -quit | grep -q . ||
     find "$node_root" -type l ! -user root -print -quit | grep -q . ||
     ! diff --brief --recursive --no-dereference "$fresh_node_root" "$node_root" >/dev/null; then
    echo 'The existing pinned Node tree is incomplete, writable, or differs from the verified archive.' >&2
    exit 1
  fi
else
  chown -hR root:root "$fresh_node_root"
  chmod -R go-w "$fresh_node_root"
  mv -- "$fresh_node_root" "$node_root"
fi
for binary in node npm npx corepack; do
  if [[ -e /usr/bin/$binary && ! -L /usr/bin/$binary ]]; then
    echo "/usr/bin/$binary is an unmanaged regular file; refusing to replace it." >&2
    exit 1
  fi
  ln -sfn "$node_root/bin/$binary" "/usr/bin/$binary"
done
if [[ $(/usr/bin/node --version) != "v${node_version}" ]] ||
   [[ $(readlink -f /usr/bin/node) != "$node_root/bin/node" ]]; then
  echo 'The pinned Node runtime was not installed at the approved path.' >&2
  exit 1
fi

if ! pg_lsclusters --no-header | awk '$1 == "17" && $2 == "main" { found=1 } END { exit !found }'; then
  pg_createcluster 17 main
fi
install -d -o root -g postgres -m 0750 /etc/postgresql/17/main/conf.d
cat > "$work_dir/pawshop-postgresql.conf" <<'EOF'
listen_addresses = '127.0.0.1'
password_encryption = 'scram-sha-256'
shared_buffers = '128MB'
work_mem = '4MB'
maintenance_work_mem = '64MB'
max_connections = 40
EOF
install -o root -g postgres -m 0640 "$work_dir/pawshop-postgresql.conf" \
  /etc/postgresql/17/main/conf.d/pawshop.conf

install -d -o root -g root -m 0755 /etc/systemd/system/redis-server.service.d
cat > "$work_dir/pawshop-redis.conf" <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/redis-server /etc/redis/redis.conf --supervised systemd --daemonize no --bind 127.0.0.1 --protected-mode yes --maxmemory 96mb --maxmemory-policy noeviction
EOF
install -o root -g root -m 0644 "$work_dir/pawshop-redis.conf" \
  /etc/systemd/system/redis-server.service.d/pawshop.conf

create_system_user() {
  local name=$1 home_dir=$2
  if ! getent passwd "$name" >/dev/null; then
    useradd --system --user-group --home-dir "$home_dir" --shell /usr/sbin/nologin "$name"
  fi
  local entry user uid gid actual_home shell primary_group all_groups group_entry group_members
  entry=$(getent passwd "$name")
  IFS=: read -r user _ uid gid _ actual_home shell <<<"$entry"
  group_entry=$(getent group "$gid")
  IFS=: read -r primary_group _ _ group_members <<<"$group_entry"
  all_groups=$(id -Gn "$name")
  if [[ $user != "$name" || ! $uid =~ ^[0-9]+$ || $uid -le 0 || $uid -ge 1000 ||
        ! $gid =~ ^[0-9]+$ || $gid -le 0 || $gid -ge 1000 ||
        $primary_group != "$name" || -n $group_members || $all_groups != "$name" ||
        $actual_home != "$home_dir" || $shell != /usr/sbin/nologin ]]; then
    echo "Existing system account does not match the approved identity: $name" >&2
    exit 1
  fi
  if getent passwd | awk -F: -v expected_user="$name" -v expected_gid="$gid" \
    '$4 == expected_gid && $1 != expected_user { found=1 } END { exit !found }'; then
    echo "The approved system group is shared by another account: $name" >&2
    exit 1
  fi
}
create_system_user pawshop /var/lib/pawshop
create_system_user pawshop-build /var/cache/pawshop-build
create_system_user pawshop-backup /nonexistent
create_system_user pawshop-restore /var/lib/pawshop-restore

install -d -o root -g pawshop -m 0750 /etc/pawshop
install -d -o pawshop -g pawshop -m 0700 /var/lib/pawshop
install -d -o pawshop-build -g pawshop-build -m 0700 /var/cache/pawshop-build /var/cache/pawshop-build/npm
install -d -o root -g pawshop-backup -m 0750 /etc/pawshop-backup
install -d -o pawshop-backup -g pawshop-backup -m 0700 /var/backups/pawshop
install -d -o root -g pawshop-restore -m 0750 /var/lib/pawshop-restore /var/lib/pawshop-restore/input
install -d -o pawshop-restore -g pawshop-restore -m 0700 \
  /var/lib/pawshop-restore/work /var/lib/pawshop-restore/verifications
install -d -o root -g root -m 0755 /srv/pawshop-commerce /srv/pawshop-commerce/releases /usr/local/libexec/pawshop

systemctl daemon-reload
systemctl enable --now postgresql@17-main.service redis-server.service
systemctl restart postgresql@17-main.service redis-server.service
systemctl is-active --quiet postgresql@17-main.service redis-server.service

actual_listeners=$(ss -lntH | awk '$4 ~ /:(5432|6379)$/ { print $4 }' | sort -u)
expected_listeners=$'127.0.0.1:5432\n127.0.0.1:6379'
if [[ $actual_listeners != "$expected_listeners" ]]; then
  echo 'PostgreSQL and Redis listeners are not exactly restricted to their IPv4 loopback ports.' >&2
  exit 1
fi
runtime_mutation_started=0

echo "PawShop host runtime prepared: Node $(/usr/bin/node --version), PostgreSQL $(psql --version), Redis $(redis-server --version | awk '{print $3}')."
echo 'Medusa, database roles, migrations, customer APIs, backups and payments remain inactive.'
