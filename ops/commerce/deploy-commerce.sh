#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root so release ownership, service activation, and rollback are controlled.' >&2
  exit 1
fi
: "${PAWSHOP_RELEASE_ID:?Set PAWSHOP_RELEASE_ID to the full Git commit SHA.}"
if [[ ${PAWSHOP_RELEASE_ACTIVATION_CONFIRMED:-0} != 1 ]]; then
  echo 'Release activation requires PAWSHOP_RELEASE_ACTIVATION_CONFIRMED=1 after backup and migration review.' >&2
  exit 1
fi
if [[ ! $PAWSHOP_RELEASE_ID =~ ^[0-9a-f]{40}$ ]]; then
  echo 'PAWSHOP_RELEASE_ID must be a full lowercase Git commit SHA.' >&2
  exit 1
fi
for required_command in git tar runuser node npm systemctl flock chown chmod install find grep mv ln readlink stat rm df tail; do
  command -v "$required_command" >/dev/null || {
    echo "Required production command is unavailable: $required_command" >&2
    exit 1
  }
done
id -u pawshop >/dev/null 2>&1 || { echo 'The pawshop service account is missing.' >&2; exit 1; }
id -u pawshop-build >/dev/null 2>&1 || { echo 'The isolated pawshop-build account is missing.' >&2; exit 1; }
systemctl cat pawshop-commerce.service >/dev/null 2>&1 || {
  echo 'The reviewed pawshop-commerce.service unit is not installed.' >&2
  exit 1
}

source_dir=/srv/pawshop-source
release_root=/srv/pawshop-commerce/releases
release_dir="$release_root/$PAWSHOP_RELEASE_ID"
staging_dir="$release_root/.${PAWSHOP_RELEASE_ID}.staging"
archive_file="$release_root/.${PAWSHOP_RELEASE_ID}.$$.tar"
current_link=/srv/pawshop-commerce/current
next_link="/srv/pawshop-commerce/.current.${PAWSHOP_RELEASE_ID}.$$"
lock_file=/run/lock/pawshop-commerce-deploy.lock
previous_target=
release_created=0
activated=0

exec 9>"$lock_file"
flock -n 9 || { echo 'Another PawShop commerce release operation is active.' >&2; exit 1; }

cleanup() {
  rm -rf -- "$staging_dir"
  rm -f -- "$archive_file"
  rm -f -- "$next_link"
}
atomic_link() {
  local target=$1
  rm -f -- "$next_link"
  ln -s -- "$target" "$next_link"
  mv -Tf -- "$next_link" "$current_link"
}
rollback() {
  local status=$?
  local restored=0
  trap - ERR INT TERM
  set +e
  if [[ $activated == 1 ]]; then
    if [[ -n $previous_target && -d $previous_target ]]; then
      if atomic_link "$previous_target" &&
         [[ -L $current_link && $(readlink -f -- "$current_link") == "$previous_target" ]] &&
         systemctl restart pawshop-commerce.service; then
        restored=1
      fi
    else
      if [[ -L $current_link && $(readlink -f -- "$current_link") == "$release_dir" ]]; then
        rm -f -- "$current_link"
      fi
      if [[ ! -e $current_link && ! -L $current_link ]] && systemctl stop pawshop-commerce.service; then
        restored=1
      fi
    fi
  else
    restored=1
  fi
  cleanup
  if [[ $release_created == 1 && $restored == 1 ]]; then
    if [[ -n $previous_target && -L $current_link ]] &&
       [[ $(readlink -f -- "$current_link") == "$previous_target" ]]; then
      rm -rf -- "$release_dir"
    elif [[ -z $previous_target && ! -e $current_link && ! -L $current_link ]]; then
      rm -rf -- "$release_dir"
    fi
  fi
  if [[ $restored == 1 ]]; then
    echo 'PawShop commerce activation failed; the previous state was restored.' >&2
  else
    echo 'CRITICAL: activation failed and automatic restoration was not verified; both releases were preserved.' >&2
    status=1
  fi
  exit "$status"
}
trap rollback ERR INT TERM

if [[ ! -d $source_dir/.git || -L $source_dir || -L $source_dir/.git ]] ||
   [[ $(stat -c '%u' -- "$source_dir") != 0 || $(stat -c '%u' -- "$source_dir/.git") != 0 ]]; then
  echo 'The fixed production source and its Git metadata must be root-owned nonsymlink directories.' >&2
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
  echo 'The production checkout must be on the exact requested commit with no tracked changes.' >&2
  exit 1
fi
if [[ -L $current_link ]]; then
  previous_target=$(readlink -f -- "$current_link")
  if [[ ! $previous_target =~ ^/srv/pawshop-commerce/releases/[0-9a-f]{40}$ ]] || [[ ! -d $previous_target ]]; then
    echo 'The current commerce release link is outside the approved release directory.' >&2
    exit 1
  fi
elif [[ -e $current_link ]]; then
  echo 'The commerce current path must be absent or a validated symbolic link.' >&2
  exit 1
fi
if [[ -e $release_dir || -L $release_dir ]]; then
  echo 'The requested commerce release already exists.' >&2
  exit 1
fi

install -d -o root -g root -m 0755 /srv/pawshop-commerce "$release_root"
install -d -o pawshop -g pawshop -m 0700 /var/lib/pawshop
install -d -o pawshop-build -g pawshop-build -m 0700 /var/cache/pawshop-build /var/cache/pawshop-build/npm
available_disk_kib=$(df -Pk "$release_root" | tail -n 1 | { read -r _ _ _ available _; printf '%s' "$available"; })
if [[ ! $available_disk_kib =~ ^[0-9]+$ ]] || (( available_disk_kib < 8388608 )); then
  echo 'Commerce release build requires at least 8 GiB free on the release filesystem.' >&2
  exit 1
fi
cleanup
install -d -o pawshop-build -g pawshop-build -m 0750 "$staging_dir"
install -o pawshop-build -g pawshop-build -m 0600 /dev/null "$archive_file"
git_readonly archive --format=tar --output="$archive_file" "$PAWSHOP_RELEASE_ID" -- _commerce
runuser -u pawshop-build -- /usr/bin/tar -xf "$archive_file" -C "$staging_dir"
if find "$staging_dir" -type l -print -quit | grep -q . || find "$staging_dir" -name '.env' -print -quit | grep -q .; then
  echo 'The commerce release contains a symbolic link or private environment file.' >&2
  exit 1
fi
chown -R pawshop-build:pawshop-build -- "$staging_dir"
runuser -u pawshop-build -- env -i HOME=/var/cache/pawshop-build LANG=C.UTF-8 PATH=/usr/bin:/bin \
  npm_config_cache=/var/cache/pawshop-build/npm /usr/bin/npm --prefix "$staging_dir/_commerce" ci --no-audit --no-fund
runuser -u pawshop-build -- env -i HOME=/var/cache/pawshop-build LANG=C.UTF-8 PATH=/usr/bin:/bin \
  /usr/bin/node "$staging_dir/_commerce/scripts/run-release-build.mjs"
runuser -u pawshop-build -- env -i HOME=/var/cache/pawshop-build LANG=C.UTF-8 PATH=/usr/bin:/bin \
  npm_config_cache=/var/cache/pawshop-build/npm /usr/bin/npm --prefix "$staging_dir/_commerce" prune --omit=dev --no-audit --no-fund

printf '%s\n' "$PAWSHOP_RELEASE_ID" > "$staging_dir/.pawshop-release"
chown -R root:root -- "$staging_dir"
chmod -R u=rwX,go=rX -- "$staging_dir"
mv -- "$staging_dir" "$release_dir"
release_created=1
activated=1
atomic_link "$release_dir"
systemctl restart pawshop-commerce.service

trap - ERR INT TERM
cleanup
echo "PawShop commerce release activated: $PAWSHOP_RELEASE_ID"
