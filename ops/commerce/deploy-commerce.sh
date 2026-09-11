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
for required_command in git runuser node systemctl flock find grep cmp mv ln readlink stat rm; do
  command -v "$required_command" >/dev/null || {
    echo "Required production command is unavailable: $required_command" >&2
    exit 1
  }
done
systemctl cat pawshop-commerce.service >/dev/null 2>&1 || {
  echo 'The reviewed pawshop-commerce.service unit is not installed.' >&2
  exit 1
}

release_root=/srv/pawshop-commerce/releases
release_dir="$release_root/$PAWSHOP_RELEASE_ID"
source_dir=/srv/pawshop-source
current_link=/srv/pawshop-commerce/current
next_link="/srv/pawshop-commerce/.current.${PAWSHOP_RELEASE_ID}.$$"
lock_file=/run/lock/pawshop-commerce-deploy.lock
previous_target=
activated=0

exec 9>"$lock_file"
flock -n 9 || { echo 'Another PawShop commerce release operation is active.' >&2; exit 1; }

cleanup() {
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
   [[ $(stat -c '%u' -- "$source_dir") != 0 || $(stat -c '%u' -- "$source_dir/.git") != 0 ]] ||
   [[ -n $(find "$source_dir" \( ! -user root -o -perm /022 \) -print -quit) ]]; then
  echo 'The trusted production source is missing or unsafe.' >&2
  exit 1
fi
git_readonly() {
  runuser -u pawshop-build -- env -i HOME=/var/cache/pawshop-build LANG=C.UTF-8 PATH=/usr/bin:/bin \
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 /usr/bin/git \
    -c safe.directory="$source_dir" -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$source_dir" "$@"
}
if [[ $(git_readonly rev-parse HEAD) != "$PAWSHOP_RELEASE_ID" ]] ||
   [[ -n $(git_readonly status --porcelain=v1 --untracked-files=all) ]]; then
  echo 'The trusted production source must be the exact clean release commit.' >&2
  exit 1
fi
if [[ ! -d $release_dir || -L $release_dir || ! -f $release_dir/.pawshop-release || -L $release_dir/.pawshop-release ]] ||
   [[ $(stat -c '%u:%g:%a' -- "$release_dir") != '0:0:755' ]] ||
   [[ $(stat -c '%u:%g:%a' -- "$release_dir/.pawshop-release") != '0:0:644' ]] ||
   [[ $(<"$release_dir/.pawshop-release") != "$PAWSHOP_RELEASE_ID" ]] ||
   find "$release_dir" \( ! -user root -o \( ! -type l -a -perm /022 \) \) -print -quit | grep -q .; then
  echo 'The exact prepared release is missing or no longer immutable.' >&2
  exit 1
fi
release_content_sha256=$(/usr/bin/node "$source_dir/_commerce/scripts/verify-release-manifest.mjs" \
  "$release_dir" "$PAWSHOP_RELEASE_ID")
/usr/bin/node "$source_dir/_commerce/scripts/verify-tracked-release.mjs" \
  "$source_dir" "$release_dir" "$PAWSHOP_RELEASE_ID" >/dev/null
/usr/bin/node "$source_dir/_commerce/scripts/verify-release-evidence.mjs" \
  "$PAWSHOP_RELEASE_ID" "$release_content_sha256"
for installed in pawshop-commerce.service pawshop-backup.service pawshop-backup.timer pawshop-restore-verify.service; do
  cmp -s "$release_dir/ops/commerce/$installed" "/etc/systemd/system/$installed" || {
    echo 'Installed runtime units do not match the exact candidate release.' >&2
    exit 1
  }
done
for installed in restore-verify-production.mjs backup-integrity.cjs; do
  cmp -s "$release_dir/_commerce/scripts/$installed" "/usr/local/libexec/pawshop/$installed" || {
    echo 'Installed libexec files do not match the exact candidate release.' >&2
    exit 1
  }
done
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
cleanup
activated=1
atomic_link "$release_dir"
systemctl restart pawshop-commerce.service

trap - ERR INT TERM
cleanup
echo "PawShop commerce release activated: $PAWSHOP_RELEASE_ID"
