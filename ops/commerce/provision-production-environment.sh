#!/usr/bin/env bash
set +x
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root to provision the PawShop production environment.' >&2
  exit 1
fi

for required_command in node install stat getent mktemp rm rmdir chmod flock cut dirname; do
  command -v "$required_command" >/dev/null || {
    echo "Required production command is unavailable: $required_command" >&2
    exit 1
  }
done

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd -- "$script_dir/../.." && pwd -P)
writer="$repo_root/_commerce/scripts/write-production-environment.mjs"
trusted_javascript=(
  "$writer"
  "$repo_root/_commerce/scripts/production-environment-builder.cjs"
  "$repo_root/_commerce/scripts/production-env-file.cjs"
  "$repo_root/_commerce/src/lib/production-policy.cjs"
)
internal_secrets=/etc/pawshop/internal-secrets.env
oss_access_key=/etc/pawshop/oss-access-key-id
oss_secret_key=/etc/pawshop/oss-secret-access-key
environment_file=/etc/pawshop/commerce.env
lock_file=/run/lock/pawshop-production-environment.lock

exec 9>"$lock_file"
flock -n 9 || {
  echo 'Another PawShop production environment operation is active.' >&2
  exit 1
}

pawshop_gid=$(getent group pawshop | cut -d: -f3)
[[ $pawshop_gid =~ ^[0-9]+$ ]] || {
  echo 'The PawShop service group is unavailable.' >&2
  exit 1
}

validate_private_file() {
  local path=$1 expected_uid=$2 expected_gid=$3 expected_mode=$4 label=$5
  if [[ ! -f $path || -L $path ]] ||
     [[ $(stat -c '%u:%g:%a' -- "$path") != "$expected_uid:$expected_gid:$expected_mode" ]]; then
    echo "$label is missing or has unsafe ownership or mode." >&2
    exit 1
  fi
}

validate_private_file "$internal_secrets" 0 "$pawshop_gid" 640 'Internal production credentials'
validate_private_file "$oss_access_key" 0 0 600 'OSS access-key ID'
validate_private_file "$oss_secret_key" 0 0 600 'OSS secret access key'
if [[ -e $environment_file || -L $environment_file ]]; then
  echo 'Existing commerce.env requires an explicit credential-rotation review.' >&2
  exit 1
fi
for trusted_file in "${trusted_javascript[@]}"; do
  if [[ ! -f $trusted_file || -L $trusted_file || $(stat -c '%u' -- "$trusted_file") != 0 ]] ||
     (( 8#$(stat -c '%a' -- "$trusted_file") & 8#022 )); then
    echo 'A reviewed production environment program is missing or writable by a non-root identity.' >&2
    exit 1
  fi
done

work_dir=$(mktemp -d /etc/pawshop/.environment.XXXXXXXX)
chmod 0700 "$work_dir"
staging="$work_dir/commerce.env"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  rm -f -- "$staging"
  rmdir -- "$work_dir" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node "$writer" "$internal_secrets" "$oss_access_key" "$oss_secret_key" "$staging"
[[ $(stat -c '%u:%g:%a' -- "$staging") == '0:0:600' ]] || {
  echo 'The staged production environment has unsafe ownership or mode.' >&2
  exit 1
}
install -o root -g pawshop -m 0640 "$staging" "$environment_file"
validate_private_file "$environment_file" 0 "$pawshop_gid" 640 'Production environment'

echo 'PawShop production environment was validated and installed with migrations disabled.'
echo 'No commerce service was started or enabled.'
