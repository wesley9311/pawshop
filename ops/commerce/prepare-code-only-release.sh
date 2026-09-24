#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root so code-only evidence remains immutable.' >&2
  exit 1
fi
: "${PAWSHOP_RELEASE_ID:?Set PAWSHOP_RELEASE_ID to the exact prepared commit.}"
if [[ ${CODE_ONLY_RELEASE:-0} != 1 ]]; then
  echo 'Code-only review requires CODE_ONLY_RELEASE=1 after confirming no database change is intended.' >&2
  exit 1
fi
if [[ ! $PAWSHOP_RELEASE_ID =~ ^[0-9a-f]{40}$ ]]; then
  echo 'PAWSHOP_RELEASE_ID must be a full lowercase Git commit SHA.' >&2
  exit 1
fi
for required_command in git runuser node systemctl flock find grep readlink stat; do
  command -v "$required_command" >/dev/null || {
    echo "Required code-only review command is unavailable: $required_command" >&2
    exit 1
  }
done

source_dir=/srv/pawshop-source
release=/srv/pawshop-commerce/releases/$PAWSHOP_RELEASE_ID
current_link=/srv/pawshop-commerce/current
environment=/etc/pawshop/commerce.env
lock_file=/run/lock/pawshop-commerce-deploy.lock

exec 9>"$lock_file"
flock -n 9 || { echo 'Another PawShop release operation is active.' >&2; exit 1; }

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
  echo 'The trusted source must be the exact clean code-only candidate.' >&2
  exit 1
fi
if [[ ! -d $release || -L $release || ! -f $release/.pawshop-release || -L $release/.pawshop-release ]] ||
   [[ $(stat -c '%u:%g:%a' -- "$release") != '0:0:755' ]] ||
   [[ $(<"$release/.pawshop-release") != "$PAWSHOP_RELEASE_ID" ]] ||
   find "$release" \( ! -user root -o \( ! -type l -a -perm /022 \) \) -print -quit | grep -q .; then
  echo 'The exact immutable code-only candidate is unavailable.' >&2
  exit 1
fi
if [[ ! -L $current_link ]]; then
  echo 'Code-only mode requires an existing active production release.' >&2
  exit 1
fi
predecessor=$(readlink -f -- "$current_link")
if [[ ! $predecessor =~ ^/srv/pawshop-commerce/releases/[0-9a-f]{40}$ || ! -d $predecessor ]]; then
  echo 'The active commerce release is outside the approved release directory.' >&2
  exit 1
fi
predecessor_id=${predecessor##*/}
[[ $predecessor_id != "$PAWSHOP_RELEASE_ID" ]] || {
  echo 'The code-only candidate is already active.' >&2
  exit 1
}
systemctl is-active --quiet pawshop-commerce.service || {
  echo 'Code-only review requires the current commerce service to be active.' >&2
  exit 1
}
grep -qx 'PAWSHOP_MIGRATIONS_CONFIRMED=1' "$environment" || {
  echo 'Code-only review requires the current migration gate to remain enabled.' >&2
  exit 1
}

release_content_sha256=$(/usr/bin/node "$source_dir/_commerce/scripts/verify-release-manifest.mjs" \
  "$release" "$PAWSHOP_RELEASE_ID")
predecessor_content_sha256=$(/usr/bin/node "$source_dir/_commerce/scripts/verify-release-manifest.mjs" \
  "$predecessor" "$predecessor_id")
/usr/bin/node "$source_dir/_commerce/scripts/verify-tracked-release.mjs" \
  "$source_dir" "$release" "$PAWSHOP_RELEASE_ID" >/dev/null
/usr/bin/node "$source_dir/_commerce/scripts/write-code-only-release-evidence.mjs" \
  "$source_dir" "$release" "$PAWSHOP_RELEASE_ID" "$release_content_sha256" \
  "$predecessor" "$predecessor_id" "$predecessor_content_sha256"

echo 'Code-only release gate approved without running a database migration or restore drill.'
echo 'The active release and commerce service remain unchanged.'
