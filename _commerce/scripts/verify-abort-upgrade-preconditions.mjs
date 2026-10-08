'use strict';

// Verify the preconditions for a controlled ABORT-UPGRADE recovery: turning the
// migration gate back from open (0) to closed (1) after a FAILED upgrade, without
// any migration evidence. This is deliberately NOT `enable` — `enable` requires a
// complete evidence chain (migration.json + backup-restore.json) because it is the
// final close before activation. An abort happens when the migration never
// produced evidence (e.g. it failed before any schema write), so the gate must be
// recoverable by a different, evidence-independent contract.
//
// An abort-upgrade may only close the gate when ALL of the following hold:
//   1. the candidate release is NOT the active `current` (it was never activated);
//   2. a pre-upgrade relation snapshot still exists in the upgrade window (the
//      failed migration left it behind — the success path removes it);
//   3. the live database's relation fingerprint still matches that snapshot
//      EXACTLY (same relations, same row counts, none missing, none shrunken), so
//      the failed migration provably produced no schema/data mutation.
//
// If any condition fails, this exits non-zero and the gate stays open; an operator
// must then choose between finishing the activation or restoring the restore point.
// This is the formal replacement for the previously-manual "edit the gate value"
// deadlock escape.

const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const {
  parseRelationsSnapshot,
  serializeRelations,
} = require('./production-upgrade-evidence.cjs');

const RELEASE_ID = /^[0-9a-f]{40}$/;

if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 4) {
  throw new Error('Abort-upgrade preconditions require root on Linux and the candidate release id.');
}
const releaseId = process.argv[2];
const environmentPath = process.argv[3];
if (!RELEASE_ID.test(releaseId || '')) {
  throw new Error('Abort-upgrade requires a full candidate release id.');
}
if (resolve(environmentPath) !== '/etc/pawshop/commerce.env') {
  throw new Error('Abort-upgrade only acts on the production environment file.');
}

// (1) The candidate must not be the active `current` release.
const currentLink = '/srv/pawshop-commerce/current';
let currentTarget = '';
try {
  currentTarget = execFileSync('/usr/bin/readlink', ['-f', '--', currentLink], { encoding: 'utf8' }).trim();
} catch {
  currentTarget = '';
}
const currentId = currentTarget.startsWith('/srv/pawshop-commerce/releases/')
  ? currentTarget.slice('/srv/pawshop-commerce/releases/'.length)
  : '';
if (currentId === releaseId) {
  throw new Error('Abort-upgrade refused: the candidate is already the active release (activation, not abort).');
}

// (2) A pre-upgrade relation snapshot must exist (the failed migration left it).
const beforeSnapshot = `/run/pawshop-upgrade/before-${releaseId}.json`;
if (!existsSync(beforeSnapshot)) {
  throw new Error('Abort-upgrade refused: no pre-upgrade relation snapshot is present to prove the database is unchanged.');
}
const beforeSource = readFileSync(beforeSnapshot, 'utf8');
const before = parseRelationsSnapshot(beforeSource);

// (3) The live database must still match the snapshot exactly.
const relationSnapshotSql =
  "SELECT coalesce(json_agg(json_build_object('schema', s.schemaname, 'table', s.tablename, 'rows', s.rows) " +
  "ORDER BY s.schemaname, s.tablename), '[]'::json) FROM (SELECT schemaname, tablename, " +
  "(xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint AS rows " +
  "FROM pg_tables WHERE schemaname = 'public') s;";
const liveSource = execFileSync('/usr/bin/runuser', ['-u', 'postgres', '--', '/usr/bin/psql',
  '--no-psqlrc', '--dbname', 'pawshop', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1',
  '--command', relationSnapshotSql], { encoding: 'utf8' });
const live = parseRelationsSnapshot(liveSource);

const liveDigest = createHash('sha256').update(serializeRelations(live)).digest('hex');
const beforeDigest = createHash('sha256').update(serializeRelations(before)).digest('hex');
if (liveDigest !== beforeDigest) {
  throw new Error('Abort-upgrade refused: the live database differs from the pre-upgrade snapshot (migration produced a mutation).');
}

// Confirm the environment is in the open (0) state so the gate flip is well-ordered.
const { parseProductionEnvironmentFile } = require('./production-env-file.cjs');
const parsed = parseProductionEnvironmentFile(readFileSync(environmentPath, 'utf8'));
if (parsed.PAWSHOP_MIGRATIONS_CONFIRMED !== '0') {
  throw new Error('Abort-upgrade requires the migration gate to be open (0) first.');
}

// eslint-disable-next-line no-console
console.log(`Abort-upgrade preconditions verified: candidate ${releaseId} is not active and the ` +
  `database fingerprint matches the pre-upgrade snapshot (${live.length} relations).`);
