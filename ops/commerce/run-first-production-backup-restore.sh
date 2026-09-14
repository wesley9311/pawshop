#!/usr/bin/env bash
set +x
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root to create and restore-verify the first production backup.' >&2
  exit 1
fi
if [[ ${PAWSHOP_FIRST_BACKUP_RESTORE_CONFIRMED:-} != 1 ]]; then
  echo 'Set PAWSHOP_FIRST_BACKUP_RESTORE_CONFIRMED=1 after reviewing this exact first-backup operation.' >&2
  exit 1
fi
if [[ $# -ne 2 || ! $1 =~ ^[0-9a-f]{40}$ || ! $2 =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Usage: run-first-production-backup-restore.sh RELEASE_ID RELEASE_CONTENT_SHA256' >&2
  exit 1
fi
for required_command in git runuser systemd-run systemctl node install stat getent cut flock mktemp comm cmp find grep sort id rm; do
  command -v "$required_command" >/dev/null || { echo "Required command is unavailable: $required_command" >&2; exit 1; }
done

release_id=$1
content_sha256=$2
source_dir=/srv/pawshop-source
release=/srv/pawshop-commerce/releases/$release_id
evidence_dir=/var/lib/pawshop-release-evidence/$release_id
backup_dir=/var/backups/pawshop
restore_root=/var/lib/pawshop-restore
restore_input=$restore_root/input
verification_dir=$restore_root/verifications
unit=pawshop-first-backup-${release_id:0:12}.service
lock_file=/run/lock/pawshop-first-production-backup.lock
snapshot=$(mktemp /run/pawshop-restore-verifications.XXXXXXXX)
staged=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  rm -f -- "$snapshot"
  if [[ $status -eq 0 && $staged -eq 1 ]]; then
    rm -f -- "$restore_input/manifest.json" "$restore_input/backup.key" "$restore_input"/pawshop_production_*.dump.enc
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
exec 9>"$lock_file"
flock -n 9 || { echo 'Another first production backup operation is active.' >&2; exit 1; }

[[ -d $release && ! -L $release && ! -e /srv/pawshop-commerce/current &&
   -f $evidence_dir/migration.json && ! -e $evidence_dir/backup-restore.json ]] || {
  echo 'The exact release is not in the required post-migration, pre-activation state.' >&2
  exit 1
}
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
if [[ $(git_readonly rev-parse HEAD) != "$release_id" ]] ||
   [[ -n $(git_readonly status --porcelain=v1 --untracked-files=all) ]]; then
  echo 'The trusted source must be the exact clean release commit.' >&2
  exit 1
fi
[[ $(/usr/bin/node "$source_dir/_commerce/scripts/verify-release-manifest.mjs" "$release" "$release_id") == "$content_sha256" ]] || {
  echo 'The immutable release does not match the approved content digest.' >&2
  exit 1
}
/usr/bin/node "$source_dir/_commerce/scripts/verify-tracked-release.mjs" \
  "$source_dir" "$release" "$release_id" >/dev/null

backup_gid=$(getent group pawshop-backup | cut -d: -f3)
restore_gid=$(getent group pawshop-restore | cut -d: -f3)
[[ $backup_gid =~ ^[0-9]+$ && $restore_gid =~ ^[0-9]+$ ]] || { echo 'Backup or restore system group is unavailable.' >&2; exit 1; }
validate_file() {
  local path=$1 uid=$2 gid=$3 mode=$4 label=$5
  [[ -f $path && ! -L $path && $(stat -c '%u:%g:%a' -- "$path") == "$uid:$gid:$mode" ]] || {
    echo "$label is missing or has unsafe ownership or permissions." >&2
    exit 1
  }
}
validate_file /etc/pawshop-backup/backup.env 0 "$backup_gid" 640 'Production backup environment'
validate_file /etc/pawshop-backup/backup.key 0 "$backup_gid" 640 'Production backup key'
validate_file /etc/pawshop-backup/backup-offsite.env 0 "$backup_gid" 640 'Offsite backup environment'
validate_file /etc/pawshop-backup/backup-s3-access-key 0 0 600 'Offsite backup access-key ID'
validate_file /etc/pawshop-backup/backup-s3-secret-key 0 0 600 'Offsite backup secret key'
for installed in restore-verify-production.mjs backup-integrity.cjs; do
  cmp -s "$release/_commerce/scripts/$installed" "/usr/local/libexec/pawshop/$installed" || {
    echo 'Installed restore verifier does not match the exact candidate release.' >&2
    exit 1
  }
done
[[ -d $restore_input && ! -L $restore_input && $(stat -c '%u:%g:%a' -- "$restore_input") == "0:$restore_gid:750" ]] || {
  echo 'Restore input directory is unsafe.' >&2
  exit 1
}
if find "$restore_input" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
  echo 'Restore input is not empty; preserve and review it before retrying.' >&2
  exit 1
fi
find "$verification_dir" -mindepth 1 -maxdepth 1 -type f -name 'verification-*.json' -printf '%f\n' | sort > "$snapshot"

systemd-run --quiet --wait --collect --unit="$unit" \
  --property=Type=oneshot --property=User=pawshop-backup --property=Group=pawshop-backup \
  --property="WorkingDirectory=$release/_commerce" \
  --property=EnvironmentFile=/etc/pawshop-backup/backup.env \
  --property=EnvironmentFile=/etc/pawshop-backup/backup-offsite.env \
  --property=LoadCredential=backup-s3-access-key:/etc/pawshop-backup/backup-s3-access-key \
  --property=LoadCredential=backup-s3-secret-key:/etc/pawshop-backup/backup-s3-secret-key \
  --property=UMask=0077 --property=NoNewPrivileges=yes --property=PrivateTmp=yes \
  --property=ProtectSystem=strict --property=ProtectHome=yes --property=ProtectKernelTunables=yes \
  --property=ProtectKernelModules=yes --property=ProtectControlGroups=yes --property=ProtectClock=yes \
  --property=RestrictSUIDSGID=yes --property=LockPersonality=yes --property=CapabilityBoundingSet= \
  --property='RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
  --property=ReadWritePaths=/var/backups/pawshop --property=TimeoutStartSec=30min \
  /usr/bin/node scripts/run-first-production-backup.mjs "$release_id"

manifest_name=$(/usr/bin/node "$release/_commerce/scripts/read-production-backup-pointer.mjs")
encrypted_name=${manifest_name%.manifest.json}.dump.enc
validate_file "$backup_dir/$manifest_name" "$(id -u pawshop-backup)" "$backup_gid" 600 'Production backup manifest'
validate_file "$backup_dir/$encrypted_name" "$(id -u pawshop-backup)" "$backup_gid" 600 'Encrypted production backup'
validate_file "$backup_dir/${manifest_name%.manifest.json}.offsite.json" "$(id -u pawshop-backup)" "$backup_gid" 600 'Offsite backup receipt'
install -o root -g pawshop-restore -m 0640 "$backup_dir/$manifest_name" "$restore_input/manifest.json"
install -o root -g pawshop-restore -m 0640 "$backup_dir/$encrypted_name" "$restore_input/$encrypted_name"
install -o root -g pawshop-restore -m 0640 /etc/pawshop-backup/backup.key "$restore_input/backup.key"
staged=1
systemctl start pawshop-restore-verify.service

verification_name=$(comm -13 "$snapshot" <(find "$verification_dir" -mindepth 1 -maxdepth 1 -type f -name 'verification-*.json' -printf '%f\n' | sort))
[[ $verification_name =~ ^verification-[0-9]+\.json$ && $verification_name != *$'\n'* ]] || {
  echo 'Exactly one new isolated restore verification was not produced.' >&2
  exit 1
}
/usr/bin/node "$release/_commerce/scripts/write-production-backup-restore-evidence.mjs" \
  "$release" "$release_id" "$content_sha256" "$manifest_name" "$verification_name"
echo 'The first production backup passed offsite read-back and isolated restore verification.'
echo 'Commerce activation remains disabled.'
