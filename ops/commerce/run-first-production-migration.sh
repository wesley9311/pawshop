#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root to control the first production migration.' >&2
  exit 1
fi
: "${PAWSHOP_RELEASE_ID:?Set PAWSHOP_RELEASE_ID to the exact prepared commit.}"
if [[ ${PAWSHOP_FIRST_MIGRATION_CONFIRMED:-0} != 1 ]]; then
  echo 'First production migration requires PAWSHOP_FIRST_MIGRATION_CONFIRMED=1 after review.' >&2
  exit 1
fi
if [[ ! $PAWSHOP_RELEASE_ID =~ ^[0-9a-f]{40}$ ]]; then
  echo 'PAWSHOP_RELEASE_ID must be a full lowercase Git commit SHA.' >&2
  exit 1
fi
for command in git runuser node psql flock find grep stat systemctl getent; do
  command -v "$command" >/dev/null || { echo "Required migration command is unavailable: $command" >&2; exit 1; }
done

source_dir=/srv/pawshop-source
release=/srv/pawshop-commerce/releases/$PAWSHOP_RELEASE_ID
environment=/etc/pawshop/commerce.env
evidence=/var/lib/pawshop-release-evidence/$PAWSHOP_RELEASE_ID/migration.json
lock_file=/run/lock/pawshop-commerce-deploy.lock
exec 9>"$lock_file"
flock -n 9 || { echo 'Another PawShop release operation is active.' >&2; exit 1; }

if [[ -e /srv/pawshop-commerce/current || -L /srv/pawshop-commerce/current ]] ||
   systemctl is-active --quiet pawshop-commerce.service; then
  echo 'First migration requires the commerce service and current release to remain absent.' >&2
  exit 1
fi
if [[ -e $evidence || -L $evidence ]]; then
  echo 'Migration evidence already exists and requires explicit recovery review.' >&2
  exit 1
fi
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
  echo 'The trusted source must be the exact clean release commit.' >&2
  exit 1
fi
if [[ ! -d $release || -L $release || ! -f $release/.pawshop-release || -L $release/.pawshop-release ]] ||
   [[ $(stat -c '%u:%g:%a' -- "$release") != '0:0:755' ]] ||
   [[ $(<"$release/.pawshop-release") != "$PAWSHOP_RELEASE_ID" ]] ||
   find "$release" \( ! -user root -o \( ! -type l -a -perm /022 \) \) -print -quit | grep -q .; then
  echo 'The exact immutable candidate release is unavailable.' >&2
  exit 1
fi
release_content_sha256=$(/usr/bin/node "$source_dir/_commerce/scripts/verify-release-manifest.mjs" \
  "$release" "$PAWSHOP_RELEASE_ID")
/usr/bin/node "$source_dir/_commerce/scripts/verify-tracked-release.mjs" \
  "$source_dir" "$release" "$PAWSHOP_RELEASE_ID" >/dev/null

pawshop_gid=$(getent group pawshop | cut -d: -f3)
[[ $(stat -c '%u:%g:%a' -- "$environment") == "0:$pawshop_gid:640" ]] || {
  echo 'The production environment file is unsafe.' >&2; exit 1;
}
grep -qx 'PAWSHOP_MIGRATIONS_CONFIRMED=0' "$environment" || {
  echo 'First migration requires the fail-closed environment gate.' >&2; exit 1;
}
relation_sql="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','S','v','m','f');"
before=$(runuser -u postgres -- psql --no-psqlrc --dbname pawshop --tuples-only --no-align \
  --set ON_ERROR_STOP=1 --command "$relation_sql")
[[ $before == 0 ]] || { echo 'First migration refused because the production database is not empty.' >&2; exit 1; }

runuser -u pawshop -- env -i HOME=/var/lib/pawshop LANG=C.UTF-8 PATH=/usr/bin:/bin \
  NODE_OPTIONS=--max-old-space-size=768 \
  /usr/bin/node "$release/_commerce/scripts/run-first-production-migration.mjs"
after=$(runuser -u postgres -- psql --no-psqlrc --dbname pawshop --tuples-only --no-align \
  --set ON_ERROR_STOP=1 --command "$relation_sql")
[[ $after =~ ^[0-9]+$ && $after -gt 0 ]] || {
  echo 'Migration returned without creating the expected production schema.' >&2; exit 1;
}
/usr/bin/node "$source_dir/_commerce/scripts/write-production-migration-evidence.mjs" \
  "$release" "$PAWSHOP_RELEASE_ID" "$release_content_sha256"
echo 'First exact-release production migration completed; commerce remains inactive.'
