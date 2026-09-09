#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root so the prepared release remains immutable.' >&2
  exit 1
fi
: "${PAWSHOP_RELEASE_ID:?Set PAWSHOP_RELEASE_ID to the full Git commit SHA.}"
if [[ ! $PAWSHOP_RELEASE_ID =~ ^[0-9a-f]{40}$ ]]; then
  echo 'PAWSHOP_RELEASE_ID must be a full lowercase Git commit SHA.' >&2
  exit 1
fi
for required_command in git tar runuser node npm flock chown chmod install find grep mv stat rm df tail getent awk id env; do
  command -v "$required_command" >/dev/null || {
    echo "Required production command is unavailable: $required_command" >&2
    exit 1
  }
done
id -u pawshop-build >/dev/null 2>&1 || {
  echo 'The isolated pawshop-build account is missing.' >&2
  exit 1
}

source_dir=/srv/pawshop-source
release_root=/srv/pawshop-commerce/releases
release_dir="$release_root/$PAWSHOP_RELEASE_ID"
staging_dir="$release_root/.${PAWSHOP_RELEASE_ID}.staging"
archive_file="$release_root/.${PAWSHOP_RELEASE_ID}.$$.tar"
lock_file=/run/lock/pawshop-commerce-deploy.lock
prepared=0
release_root_validated=0

exec 9>"$lock_file"
flock -n 9 || { echo 'Another PawShop commerce release operation is active.' >&2; exit 1; }

cleanup() {
  local cleanup_failed=0
  if [[ $release_root_validated == 1 ]]; then
    rm -rf -- "$staging_dir" || cleanup_failed=1
    rm -f -- "$archive_file" || cleanup_failed=1
    [[ ! -e $staging_dir && ! -L $staging_dir ]] || cleanup_failed=1
    [[ ! -e $archive_file && ! -L $archive_file ]] || cleanup_failed=1
  fi
  return "$cleanup_failed"
}
on_exit() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  cleanup || status=1
  if (( status != 0 )); then
    if [[ $prepared == 1 ]]; then
      echo 'Prepared release creation failed after finalization; the immutable candidate was retained for review.' >&2
    else
      echo 'Prepared release creation failed; temporary artifacts were removed.' >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

validate_root_directory() {
  local path=$1
  if [[ ! -d $path || -L $path || $(stat -c '%u:%g:%a' -- "$path") != '0:0:755' ]]; then
    echo "Production release directory has unsafe ownership, type, or permissions: $path" >&2
    exit 1
  fi
}
validate_private_directory() {
  local path=$1 expected_uid=$2 expected_gid=$3 expected_mode=$4
  if [[ ! -d $path || -L $path || $(stat -c '%u:%g:%a' -- "$path") != "$expected_uid:$expected_gid:$expected_mode" ]]; then
    echo "Private build directory has unsafe ownership, type, or permissions: $path" >&2
    exit 1
  fi
}
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
    echo "PawShop build account no longer matches its private identity contract: $name" >&2
    exit 1
  fi
  if getent passwd | awk -F: -v expected_user="$name" -v expected_gid="$gid" \
    '$4 == expected_gid && $1 != expected_user { found=1 } END { exit !found }'; then
    echo "The PawShop build account private group is shared by another account: $name" >&2
    exit 1
  fi
}

validate_system_account pawshop-build /var/cache/pawshop-build

validate_root_directory /srv
if [[ ! -e /srv/pawshop-commerce && ! -L /srv/pawshop-commerce ]]; then
  install -d -o root -g root -m 0755 /srv/pawshop-commerce
fi
validate_root_directory /srv/pawshop-commerce
if [[ ! -e $release_root && ! -L $release_root ]]; then
  install -d -o root -g root -m 0755 "$release_root"
fi
validate_root_directory "$release_root"
release_root_validated=1

validate_root_directory /var
validate_root_directory /var/cache
build_uid=$(id -u pawshop-build)
build_gid=$(id -g pawshop-build)
for build_path in /var/cache/pawshop-build /var/cache/pawshop-build/npm; do
  if [[ ! -e $build_path && ! -L $build_path ]]; then
    install -d -o pawshop-build -g pawshop-build -m 0700 "$build_path"
  fi
  validate_private_directory "$build_path" "$build_uid" "$build_gid" 700
done

if [[ ! -d $source_dir/.git || -L $source_dir || -L $source_dir/.git ]] ||
   [[ $(stat -c '%u' -- "$source_dir") != 0 || $(stat -c '%u' -- "$source_dir/.git") != 0 ]]; then
  echo 'The fixed production source and its Git metadata must be root-owned nonsymlink directories.' >&2
  exit 1
fi
unsafe_source_path=$(find "$source_dir" \( ! -user root -o -perm /022 \) -print -quit)
if [[ -n $unsafe_source_path ]]; then
  echo 'The fixed production source must be entirely root-owned and non-writable by group or others.' >&2
  exit 1
fi
git_readonly() {
  runuser -u pawshop-build -- env -i HOME=/var/cache/pawshop-build LANG=C.UTF-8 PATH=/usr/bin:/bin \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 /usr/bin/git \
    -c safe.directory="$source_dir" -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$source_dir" "$@"
}
resolved_commit=$(git_readonly rev-parse --verify "$PAWSHOP_RELEASE_ID^{commit}")
if [[ $resolved_commit != "$PAWSHOP_RELEASE_ID" ]] ||
   [[ $(git_readonly rev-parse HEAD) != "$PAWSHOP_RELEASE_ID" ]] ||
   [[ -n $(git_readonly status --porcelain=v1 --untracked-files=all) ]]; then
  echo 'The production checkout must be on the exact requested commit with no tracked or untracked changes.' >&2
  exit 1
fi
if [[ -e $release_dir || -L $release_dir || -e $staging_dir || -L $staging_dir ]]; then
  echo 'The requested release or its staging path already exists and requires operator review.' >&2
  exit 1
fi

available_disk_kib=$(df -Pk "$release_root" | tail -n 1 | { read -r _ _ _ available _; printf '%s' "$available"; })
if [[ ! $available_disk_kib =~ ^[0-9]+$ ]] || (( available_disk_kib < 8388608 )); then
  echo 'Commerce release preparation requires at least 8 GiB free on the release filesystem.' >&2
  exit 1
fi

install -d -o pawshop-build -g pawshop-build -m 0750 "$staging_dir"
install -o pawshop-build -g pawshop-build -m 0600 /dev/null "$archive_file"
git_readonly archive --format=tar --output="$archive_file" "$PAWSHOP_RELEASE_ID" -- _commerce
runuser -u pawshop-build -- /usr/bin/tar -xf "$archive_file" -C "$staging_dir"
if find "$staging_dir" -type l -print -quit | grep -q . ||
   find "$staging_dir" -name '.env' -print -quit | grep -q .; then
  echo 'The commerce release contains a symbolic link or private environment file.' >&2
  exit 1
fi
chown -R pawshop-build:pawshop-build -- "$staging_dir"
runuser -u pawshop-build -- env -i HOME=/var/cache/pawshop-build LANG=C.UTF-8 PATH=/usr/bin:/bin \
  npm_config_cache=/var/cache/pawshop-build/npm npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null \
  /usr/bin/npm --prefix "$staging_dir/_commerce" ci --no-audit --no-fund
runuser -u pawshop-build -- env -i HOME=/var/cache/pawshop-build LANG=C.UTF-8 PATH=/usr/bin:/bin \
  /usr/bin/node "$staging_dir/_commerce/scripts/run-release-build.mjs"
runuser -u pawshop-build -- env -i HOME=/var/cache/pawshop-build LANG=C.UTF-8 PATH=/usr/bin:/bin \
  npm_config_cache=/var/cache/pawshop-build/npm npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null \
  /usr/bin/npm --prefix "$staging_dir/_commerce" prune --omit=dev --no-audit --no-fund

printf '%s\n' "$PAWSHOP_RELEASE_ID" > "$staging_dir/.pawshop-release"
chown -R root:root -- "$staging_dir"
chmod -R u=rwX,go=rX -- "$staging_dir"
mv -- "$staging_dir" "$release_dir"
prepared=1

unsafe_release_path=$(find "$release_dir" \( ! -user root -o -perm /022 \) -print -quit)
if [[ ! -d $release_dir || -L $release_dir || ! -f $release_dir/.pawshop-release ]] ||
   [[ $(stat -c '%u:%g:%a' -- "$release_dir") != '0:0:755' ]] ||
   [[ $(stat -c '%u:%g:%a' -- "$release_dir/.pawshop-release") != '0:0:644' ]] ||
   [[ $(<"$release_dir/.pawshop-release") != "$PAWSHOP_RELEASE_ID" ]] ||
   [[ -n $unsafe_release_path ]]; then
  echo 'The prepared commerce release failed its immutable identity check.' >&2
  exit 1
fi

echo "PawShop commerce release prepared without activation: $PAWSHOP_RELEASE_ID"
echo 'The current release link and all systemd units remain unchanged.'
