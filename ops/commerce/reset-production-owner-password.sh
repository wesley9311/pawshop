#!/usr/bin/env bash
set +x
set -Eeuo pipefail

# Rotate the production owner password on the active release, then prove it works.
#
# This is the way back in when the owner cannot log in and no mail relay is
# configured yet. It is deliberately a two-part operation: the rotation writes the
# hash, and the verification that follows performs a real authentication against
# the running service. A rotation that cannot be logged into is a failure, not a
# success, so the script never reports the new password as usable on its own say-so.

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root: the owner credentials file lives in /root.' >&2
  exit 1
fi
if [[ ${PAWSHOP_PRODUCTION_OWNER_ROTATION_CONFIRMED:-} != 1 ]]; then
  echo 'Set PAWSHOP_PRODUCTION_OWNER_ROTATION_CONFIRMED=1 after reviewing this exact rotation.' >&2
  exit 1
fi
for command in node readlink flock systemctl runuser; do
  command -v "$command" >/dev/null || { echo "Required rotation command is unavailable: $command" >&2; exit 1; }
done

release=$(readlink -f /srv/pawshop-commerce/current)
release_id=${release##*/}
if [[ ! $release =~ ^/srv/pawshop-commerce/releases/[0-9a-f]{40}$ ]]; then
  echo 'The active commerce release is not an immutable release directory.' >&2
  exit 1
fi

lock_file=/run/lock/pawshop-commerce-deploy.lock
exec 9>"$lock_file"
flock -n 9 || { echo 'Another PawShop commerce release operation is active.' >&2; exit 1; }

/usr/bin/node "$release/_commerce/scripts/reset-production-owner-password.mjs" "$release" "$release_id"

# Medusa caches provider identities, so a restart makes the new hash the only one
# in play. The service is restarted rather than assumed stale-free: guessing here
# would turn a cache hit into a false "the new password does not work".
systemctl restart pawshop-commerce.service
runuser -u pawshop -- env -i HOME=/var/lib/pawshop LANG=C.UTF-8 PATH=/usr/bin:/bin \
  /usr/bin/node "$release/_commerce/scripts/wait-production-admin.mjs"

if ! /usr/bin/node "$release/_commerce/scripts/verify-production-owner-login.mjs" "$release" "$release_id"; then
  cat >&2 <<'FAILED'
CRITICAL: the password was rewritten but the new credential could not log in.
The account may now be unusable with either password. The credential file was
updated, so inspect it and re-run this script before reporting the rotation.
FAILED
  exit 1
fi

echo 'Production owner password rotated and verified by a real authenticated login.'
echo 'The new password exists only in /root/pawshop-production-owner-credentials.json (mode 0600).'
