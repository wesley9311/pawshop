#!/usr/bin/env bash
set -Eeuo pipefail

# Migrating production onto a new release when the database already holds data.
#
# The first-migration path refuses exactly this case, on purpose, so the upgrade
# carries its own guards instead of borrowing that script's weaker premise:
#
#   1. a restore point is taken *before* anything changes and is verified after
#      the fact (authenticated manifest, re-hashed dump, offsite receipt),
#   2. the migration gate is closed and the service is stopped, so old code can
#      never run against a half-changed schema,
#   3. exact per-table row counts are captured on both sides and the record is
#      refused if a relation vanished or lost rows.
#
# The service is deliberately left stopped when this exits successfully: the
# candidate release is activated by deploy-commerce.sh, after the post-migration
# backup and isolated restore drill. If any step fails, the gate stays closed and
# the service stays down - the recovery is either to finish the activation or to
# restore $pre_manifest, and that decision is not this script's to make.

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo 'Run as root to control the production upgrade migration.' >&2
  exit 1
fi
: "${PAWSHOP_RELEASE_ID:?Set PAWSHOP_RELEASE_ID to the exact prepared commit.}"
if [[ ${PAWSHOP_UPGRADE_CONFIRMED:-0} != 1 ]]; then
  echo 'The production upgrade requires PAWSHOP_UPGRADE_CONFIRMED=1 after review.' >&2
  exit 1
fi
if [[ ! $PAWSHOP_RELEASE_ID =~ ^[0-9a-f]{40}$ ]]; then
  echo 'PAWSHOP_RELEASE_ID must be a full lowercase Git commit SHA.' >&2
  exit 1
fi
for required_command in git runuser node psql flock find grep stat systemctl getent cut install; do
  command -v "$required_command" >/dev/null || { echo "Required upgrade command is unavailable: $required_command" >&2; exit 1; }
done

source_dir=/srv/pawshop-source
release=/srv/pawshop-commerce/releases/$PAWSHOP_RELEASE_ID
current_link=/srv/pawshop-commerce/current
environment=/etc/pawshop/commerce.env
evidence_dir=/var/lib/pawshop-release-evidence/$PAWSHOP_RELEASE_ID
window=/run/pawshop-upgrade
lock_file=/run/lock/pawshop-commerce-deploy.lock
pre_manifest=''
exec 9>"$lock_file"
flock -n 9 || { echo 'Another PawShop release operation is active.' >&2; exit 1; }

report_failure() {
  local status=$?
  trap - ERR INT TERM
  echo 'The production upgrade did not complete. The migration gate stays closed and the' >&2
  echo 'commerce service stays stopped so no code runs against the current schema state.' >&2
  if [[ -n $pre_manifest ]]; then
    echo "Verified restore point from before the change: $pre_manifest" >&2
  fi
  echo 'Decide between finishing the activation (backup-restore + deploy) or restoring the' >&2
  echo 'restore point above; do not start the commerce service to "check" the database.' >&2
  exit "$status"
}
trap report_failure ERR INT TERM

if [[ ! -L $current_link ]]; then
  echo 'The upgrade requires an activated commerce release to upgrade.' >&2
  exit 1
fi
current_target=$(readlink -f -- "$current_link")
if [[ ! $current_target =~ ^/srv/pawshop-commerce/releases/[0-9a-f]{40}$ || ! -d $current_target ]]; then
  echo 'The current commerce release link is outside the approved release directory.' >&2
  exit 1
fi
predecessor=${current_target##*/}
[[ $predecessor != "$PAWSHOP_RELEASE_ID" ]] || {
  echo 'The candidate release is already the active release.' >&2; exit 1;
}
systemctl is-active --quiet pawshop-commerce.service || {
  echo 'The upgrade requires the running commerce service that owns the current data.' >&2; exit 1;
}
[[ ! -e $evidence_dir/migration.json && ! -e $evidence_dir/backup-restore.json ]] || {
  echo 'Release evidence already exists and requires explicit recovery review.' >&2; exit 1;
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
grep -qx 'PAWSHOP_MIGRATIONS_CONFIRMED=1' "$environment" || {
  echo 'An upgrade requires the running release migration gate to be enabled.' >&2; exit 1;
}

# The restore point comes first and from the release that produced the data: the
# scheduled backup unit runs the active release's own tooling and uploads to the
# object store in the same process, so a failure here is a refusal, not a warning.
if ! systemctl start pawshop-backup.service; then
  echo 'The pre-upgrade backup did not succeed; refusing to change the database.' >&2
  exit 1
fi
if [[ $(systemctl show pawshop-backup.service -p Result --value) != success ||
      $(systemctl show pawshop-backup.service -p ExecMainStatus --value) != 0 ]]; then
  echo 'The pre-upgrade backup reported failure; refusing to change the database.' >&2
  exit 1
fi
pre_manifest=$(/usr/bin/node "$current_target/_commerce/scripts/read-production-backup-pointer.mjs")
[[ -n $pre_manifest ]] || { echo 'The pre-upgrade backup left no readable pointer.' >&2; exit 1; }
echo "Pre-upgrade restore point: $pre_manifest"

if [[ -e $window ]]; then
  if find "$window" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo 'The upgrade window directory is not empty; preserve and review it before retrying.' >&2
    exit 1
  fi
else
  install -d -o root -g root -m 0700 "$window"
fi
before_snapshot=$window/before-$PAWSHOP_RELEASE_ID.json
after_snapshot=$window/after-$PAWSHOP_RELEASE_ID.json

# Exact counts, not estimates: pg_stat_user_tables lags behind the migration and
# would report a stale number as a lost row. The same query runs on both sides.
relation_snapshot_sql="SELECT coalesce(json_agg(json_build_object('schema', s.schemaname, 'table', s.tablename, 'rows', s.rows) ORDER BY s.schemaname, s.tablename), '[]'::json) FROM (SELECT schemaname, tablename, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint AS rows FROM pg_tables WHERE schemaname = 'public') s;"
capture_relations() {
  local target=$1
  (umask 077; runuser -u postgres -- psql --no-psqlrc --dbname pawshop --tuples-only --no-align \
    --set ON_ERROR_STOP=1 --command "$relation_snapshot_sql" > "$target")
  chown root:root "$target"
  chmod 0600 "$target"
}

/usr/bin/node "$release/_commerce/scripts/write-production-migration-gate.mjs" \
  "$release" "$PAWSHOP_RELEASE_ID" "$release_content_sha256" open-upgrade

systemctl stop pawshop-commerce.service
if systemctl is-active --quiet pawshop-commerce.service; then
  echo 'The commerce service did not stop; refusing to migrate under a running server.' >&2
  exit 1
fi

capture_relations "$before_snapshot"
# The candidate is the second release this database will see, so an empty
# database belongs to the first-activation path, not here. Checked before the
# schema is touched, not after.
/usr/bin/node -e "
const { parseRelationsSnapshot, totals } = require('$release/_commerce/scripts/production-upgrade-evidence.cjs');
const entries = parseRelationsSnapshot(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const { tables, rows } = totals(entries);
if (tables < 1) { console.error('The production database has no relations to upgrade.'); process.exit(1); }
console.log('Relations before the upgrade: ' + tables + ' (' + rows + ' rows)');
" "$before_snapshot"

runuser -u pawshop -- env -i HOME=/var/lib/pawshop LANG=C.UTF-8 PATH=/usr/bin:/bin \
  NODE_OPTIONS=--max-old-space-size=768 \
  /usr/bin/node "$release/_commerce/scripts/run-first-production-migration.mjs"

capture_relations "$after_snapshot"
/usr/bin/node "$release/_commerce/scripts/write-production-upgrade-evidence.mjs" \
  "$release" "$PAWSHOP_RELEASE_ID" "$release_content_sha256" "$predecessor" "$pre_manifest" \
  "$before_snapshot" "$after_snapshot"

trap - ERR INT TERM
echo 'The production database was upgraded onto the candidate release with a verified restore point.'
echo "The migration gate is closed and the commerce service is stopped. Next: the post-migration"
echo 'backup and isolated restore drill, then deploy-commerce.sh.'
