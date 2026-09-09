#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root to install reviewed dormant PawShop runtime files.' >&2
  exit 1
fi
: "${PAWSHOP_RELEASE_ID:?Set PAWSHOP_RELEASE_ID to the full prepared Git commit SHA.}"
if [[ ! $PAWSHOP_RELEASE_ID =~ ^[0-9a-f]{40}$ ]]; then
  echo 'PAWSHOP_RELEASE_ID must be a full lowercase Git commit SHA.' >&2
  exit 1
fi
for command in git runuser systemctl install stat find grep cmp flock awk id getent; do
  command -v "$command" >/dev/null || { echo "Required installer command is unavailable: $command" >&2; exit 1; }
done

release=/srv/pawshop-commerce/releases/$PAWSHOP_RELEASE_ID
source_dir=/srv/pawshop-source
lock_file=/run/lock/pawshop-commerce-deploy.lock
exec 9>"$lock_file"
flock -n 9 || { echo 'Another PawShop commerce release operation is active.' >&2; exit 1; }
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
if [[ ! -d /usr/local/libexec/pawshop || -L /usr/local/libexec/pawshop ]] ||
   [[ $(stat -c '%u:%g:%a' -- /usr/local/libexec/pawshop) != '0:0:755' ]]; then
  echo 'The fixed PawShop libexec directory is missing or unsafe.' >&2
  exit 1
fi
if [[ ! -d $release || -L $release || ! -f $release/.pawshop-release || -L $release/.pawshop-release ]] ||
   [[ $(stat -c '%u:%g:%a' -- "$release") != '0:0:755' ]] ||
   [[ $(<"$release/.pawshop-release") != "$PAWSHOP_RELEASE_ID" ]] ||
   find "$release" \( ! -user root -o -perm /022 \) -print -quit | grep -q .; then
  echo 'The requested prepared release is missing or not immutable.' >&2
  exit 1
fi
/usr/bin/node "$source_dir/_commerce/scripts/verify-release-manifest.mjs" "$release" "$PAWSHOP_RELEASE_ID" >/dev/null
/usr/bin/node "$source_dir/_commerce/scripts/verify-tracked-release.mjs" \
  "$source_dir" "$release" "$PAWSHOP_RELEASE_ID" >/dev/null
if [[ -e /srv/pawshop-commerce/current || -L /srv/pawshop-commerce/current ]]; then
  echo 'Dormant first installation requires no active commerce release.' >&2
  exit 1
fi

units=(pawshop-commerce.service pawshop-backup.service pawshop-backup.timer pawshop-restore-verify.service)
for unit in "${units[@]}"; do
  if systemctl is-active --quiet "$unit"; then
    echo "Refusing to install over an active PawShop unit: $unit" >&2
    exit 1
  fi
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
  if [[ $unit == pawshop-commerce.service || $unit == pawshop-backup.timer ]]; then
    expected_enabled=disabled
  else
    expected_enabled=static
  fi
  if [[ $enabled != "$expected_enabled" && $enabled != not-found ]]; then
    echo "Refusing to install over an enabled PawShop unit: $unit" >&2
    exit 1
  fi
done

for target in /etc/systemd/system/pawshop-commerce.service /etc/systemd/system/pawshop-backup.service \
  /etc/systemd/system/pawshop-backup.timer /etc/systemd/system/pawshop-restore-verify.service; do
  [[ ! -e $target && ! -L $target ]] || { echo "Existing runtime file requires operator review: $target" >&2; exit 1; }
done
if find /usr/local/libexec/pawshop -mindepth 1 -print -quit | grep -q .; then
  echo 'Existing PawShop libexec files require operator review.' >&2
  exit 1
fi

for unit in "${units[@]}"; do
  install -o root -g root -m 0644 "$release/ops/commerce/$unit" "/etc/systemd/system/$unit"
  cmp -s "$release/ops/commerce/$unit" "/etc/systemd/system/$unit"
done
for script in restore-verify-production.mjs backup-integrity.cjs; do
  install -o root -g root -m 0555 "$release/_commerce/scripts/$script" "/usr/local/libexec/pawshop/$script"
  cmp -s "$release/_commerce/scripts/$script" "/usr/local/libexec/pawshop/$script"
done
systemctl daemon-reload
for unit in "${units[@]}"; do
  systemctl is-active --quiet "$unit" && { echo "Dormant unit unexpectedly became active: $unit" >&2; exit 1; }
  enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
  if [[ $unit == pawshop-commerce.service || $unit == pawshop-backup.timer ]]; then
    [[ $enabled == disabled ]] || { echo "Dormant unit has an unexpected enablement state: $unit" >&2; exit 1; }
  else
    [[ $enabled == static ]] || { echo "Dormant oneshot unit has an unexpected enablement state: $unit" >&2; exit 1; }
  fi
done
echo "PawShop runtime files installed dormant from release $PAWSHOP_RELEASE_ID."
echo 'No commerce unit was started or enabled.'
