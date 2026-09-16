#!/usr/bin/env bash
set +x
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root to finalize the production administration service.' >&2
  exit 1
fi
if [[ ${PAWSHOP_PRODUCTION_ADMIN_FINALIZATION_CONFIRMED:-} != 1 ]]; then
  echo 'Set PAWSHOP_PRODUCTION_ADMIN_FINALIZATION_CONFIRMED=1 after reviewing this exact finalization.' >&2
  exit 1
fi
if [[ $# -ne 1 || ! $1 =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Usage: finalize-production-admin.sh RELEASE_ID' >&2
  exit 1
fi
for command in node runuser systemctl readlink flock; do
  command -v "$command" >/dev/null || { echo "Required finalization command is unavailable: $command" >&2; exit 1; }
done
release_id=$1
release=/srv/pawshop-commerce/releases/$release_id
lock_file=/run/lock/pawshop-commerce-deploy.lock
mutation_started=0
was_service_enabled=0
timers=(pawshop-backup.timer pawshop-backup-monthly.timer pawshop-backup-yearly.timer)
declare -A was_timer_enabled=()
declare -A was_timer_active=()
exec 9>"$lock_file"
flock -n 9 || { echo 'Another PawShop finalization operation is active.' >&2; exit 1; }

systemctl is-enabled --quiet pawshop-commerce.service && was_service_enabled=1 || true
for timer in "${timers[@]}"; do
  was_timer_enabled[$timer]=0
  was_timer_active[$timer]=0
  systemctl is-enabled --quiet "$timer" && was_timer_enabled[$timer]=1 || true
  systemctl is-active --quiet "$timer" && was_timer_active[$timer]=1 || true
done
rollback_enablement() {
  local status=$?
  local restored=1
  trap - ERR INT TERM
  set +e
  if [[ $mutation_started == 1 ]]; then
    for timer in "${timers[@]}"; do
      if [[ ${was_timer_active[$timer]} == 1 ]]; then
        systemctl is-active --quiet "$timer" || restored=0
      else
        systemctl stop "$timer" || restored=0
        systemctl is-active --quiet "$timer" && restored=0
      fi
      if [[ ${was_timer_enabled[$timer]} == 1 ]]; then
        systemctl is-enabled --quiet "$timer" || restored=0
      else
        systemctl disable "$timer" >/dev/null || restored=0
        systemctl is-enabled --quiet "$timer" && restored=0
      fi
    done
    if [[ $was_service_enabled == 1 ]]; then
      systemctl is-enabled --quiet pawshop-commerce.service || restored=0
    else
      systemctl disable pawshop-commerce.service >/dev/null || restored=0
      systemctl is-enabled --quiet pawshop-commerce.service && restored=0
    fi
  fi
  if [[ $restored == 1 ]]; then
    echo 'Production admin persistence finalization failed; prior enablement state was restored.' >&2
  else
    echo 'CRITICAL: production admin persistence finalization failed and prior systemd state was not restored; inspect both PawShop units.' >&2
    status=1
  fi
  exit "$status"
}
trap rollback_enablement ERR INT TERM

[[ -L /srv/pawshop-commerce/current && $(readlink -f /srv/pawshop-commerce/current) == "$release" ]] || {
  echo 'The active commerce link does not match the exact release.' >&2
  exit 1
}
systemctl is-active --quiet pawshop-commerce.service || { echo 'The production administration service is not active.' >&2; exit 1; }
/usr/bin/node "$release/_commerce/scripts/create-production-owner.mjs" "$release" "$release_id"
/usr/bin/node "$release/_commerce/scripts/verify-production-owner-login.mjs" "$release" "$release_id"
runuser -u pawshop -- env -i HOME=/var/lib/pawshop LANG=C.UTF-8 PATH=/usr/bin:/bin \
  /usr/bin/node "$release/_commerce/scripts/run-production-admin-verification.mjs"

[[ -L /srv/pawshop-commerce/current && $(readlink -f /srv/pawshop-commerce/current) == "$release" ]] || {
  echo 'The active release changed during finalization.' >&2
  exit 1
}
mutation_started=1
systemctl enable pawshop-commerce.service "${timers[@]}" >/dev/null
systemctl start "${timers[@]}"
systemctl is-enabled --quiet pawshop-commerce.service
systemctl is-active --quiet pawshop-commerce.service
for timer in "${timers[@]}"; do
  systemctl is-enabled --quiet "$timer"
  systemctl is-active --quiet "$timer"
done
trap - ERR INT TERM
echo 'Production admin is persistent and verified; daily, monthly, and yearly encrypted offsite backups are scheduled.'
echo 'Public customer registration, checkout, and payment remain closed.'
