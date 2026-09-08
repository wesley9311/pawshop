#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root so the commerce release link and service are controlled.' >&2
  exit 1
fi
: "${PAWSHOP_ROLLBACK_RELEASE_ID:?Set PAWSHOP_ROLLBACK_RELEASE_ID to a retained full Git commit SHA.}"
if [[ ${PAWSHOP_ROLLBACK_COMPATIBLE:-0} != 1 ]]; then
  echo 'Rollback requires PAWSHOP_ROLLBACK_COMPATIBLE=1 after database-schema compatibility review.' >&2
  exit 1
fi
if [[ ! $PAWSHOP_ROLLBACK_RELEASE_ID =~ ^[0-9a-f]{40}$ ]]; then
  echo 'PAWSHOP_ROLLBACK_RELEASE_ID must be a full lowercase Git commit SHA.' >&2
  exit 1
fi
for required_command in systemctl flock mv ln readlink stat rm find grep; do
  command -v "$required_command" >/dev/null || { echo "Required rollback command is unavailable: $required_command" >&2; exit 1; }
done

release_root=/srv/pawshop-commerce/releases
target="$release_root/$PAWSHOP_ROLLBACK_RELEASE_ID"
current_link=/srv/pawshop-commerce/current
next_link="/srv/pawshop-commerce/.rollback.${PAWSHOP_ROLLBACK_RELEASE_ID}.$$"
lock_file=/run/lock/pawshop-commerce-deploy.lock
previous_target=
switched=0

exec 9>"$lock_file"
flock -n 9 || { echo 'Another PawShop commerce release operation is active.' >&2; exit 1; }
if [[ ! -d $target || -L $target || ! -f $target/.pawshop-release || -L $target/.pawshop-release ]] ||
   [[ $(stat -c '%u:%g:%a' -- "$target") != '0:0:755' ]] ||
   [[ $(stat -c '%u:%g:%a' -- "$target/.pawshop-release") != '0:0:644' ]] ||
   [[ $(<"$target/.pawshop-release") != "$PAWSHOP_ROLLBACK_RELEASE_ID" ]]; then
  echo 'The requested retained release is missing or has an invalid identity marker.' >&2
  exit 1
fi
if find "$target" \( ! -user root -o -perm /022 \) -print -quit | grep -q .; then
  echo 'The requested retained release must remain root-owned and non-writable by group or others.' >&2
  exit 1
fi
if [[ ! -L $current_link ]]; then
  echo 'The current commerce release is not a symbolic link.' >&2
  exit 1
fi
previous_target=$(readlink -f -- "$current_link")
if [[ ! $previous_target =~ ^/srv/pawshop-commerce/releases/[0-9a-f]{40}$ ]] || [[ ! -d $previous_target ]]; then
  echo 'The current commerce release is outside the approved release directory.' >&2
  exit 1
fi
if [[ $previous_target == "$target" ]]; then
  echo 'The requested rollback release is already active.' >&2
  exit 1
fi

atomic_link() {
  rm -f -- "$next_link"
  ln -s -- "$1" "$next_link"
  mv -Tf -- "$next_link" "$current_link"
}
restore_previous() {
  local status=$?
  local restored=0
  trap - ERR INT TERM
  set +e
  rm -f -- "$next_link"
  if [[ $switched == 1 ]]; then
    if [[ -L $current_link && $(readlink -f -- "$current_link") == "$previous_target" ]]; then
      restored=1
    elif atomic_link "$previous_target" &&
         [[ -L $current_link && $(readlink -f -- "$current_link") == "$previous_target" ]] &&
         systemctl restart pawshop-commerce.service; then
      restored=1
    fi
  else
    restored=1
  fi
  if [[ $restored == 1 ]]; then
    echo 'PawShop commerce rollback failed; the original release was restored.' >&2
  else
    echo 'CRITICAL: rollback failed and restoration was not verified; both releases were preserved.' >&2
    status=1
  fi
  exit "$status"
}
trap restore_previous ERR INT TERM

switched=1
atomic_link "$target"
systemctl restart pawshop-commerce.service

trap - ERR INT TERM
rm -f -- "$next_link"
echo "PawShop commerce rollback activated: $PAWSHOP_ROLLBACK_RELEASE_ID"
