#!/bin/bash
# Run the password-reset delivery acceptance against the active release.
#
# The expected outcome is an argument rather than something the script infers:
# "delivered" once a mail relay is configured, "no-relay" while it deliberately
# is not. The verifier itself refuses to proceed when that expectation
# disagrees with the credential file on disk.
#
#   run-password-reset-verification.sh delivered
#   run-password-reset-verification.sh no-relay
set -euo pipefail

if [ "$#" -ne 1 ] || { [ "$1" != "delivered" ] && [ "$1" != "no-relay" ]; }; then
  echo "usage: $0 delivered|no-relay" >&2
  exit 2
fi
expected="$1"

current=/srv/pawshop-commerce/current
release=$(readlink -f "$current")
release_id=$(basename "$release")
if [ ! -d "$release" ] || ! printf '%s' "$release_id" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "The active release could not be resolved to a commit identity." >&2
  exit 1
fi

# The verifier is looked for next to this script first, then under /root (where
# it lives while the running release predates it), then inside the release.
here=$(cd "$(dirname "$0")" && pwd)
verifier=""
for candidate in \
  "$here/verify-password-reset-delivery.mjs" \
  "/root/pawshop-verify-password-reset-delivery.mjs" \
  "$release/_commerce/scripts/verify-password-reset-delivery.mjs"
do
  if [ -f "$candidate" ]; then verifier="$candidate"; break; fi
done
if [ -z "$verifier" ]; then
  echo "The password-reset verifier was not found." >&2
  exit 1
fi

exec /usr/bin/node "$verifier" "$release" "$release_id" "$expected"
