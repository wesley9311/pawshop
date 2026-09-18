'use strict';

// Upgrading a database that already holds business data is a different act from
// creating one from nothing, so it carries its own evidence instead of reusing
// the empty-database record with a looser check. The record has to answer three
// questions a reviewer will ask: which release was running before, where is the
// restore point that predates the schema change, and what proves the data
// survived it.
//
// The restore point is a real encrypted dump whose authentication is verified
// separately (production-backup-verification.cjs): it is the guarantee. The
// relation snapshot here is the tripwire: exact per-table row counts before and
// after, and the migration is refused if any table that existed before is gone
// or holds fewer rows. Row counts and not row contents, because a migration is
// allowed to add a column to a table without that counting as data loss.

const { createHash } = require('node:crypto');

const RELEASE_ID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELATION_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const MAXIMUM_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_FIELDS = ['schema', 'table', 'rows'];

function parseRelationsSnapshot(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAXIMUM_SNAPSHOT_BYTES ||
      source.includes('\0')) {
    throw new Error('A relation snapshot has an unsafe format.');
  }
  let parsed;
  try { parsed = JSON.parse(source); }
  catch { throw new Error('A relation snapshot is not valid JSON.'); }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('A relation snapshot must list at least one relation.');
  }
  const entries = parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).sort().join('\0') !== [...SNAPSHOT_FIELDS].sort().join('\0') ||
        !RELATION_NAME.test(entry.schema || '') || !RELATION_NAME.test(entry.table || '') ||
        !Number.isSafeInteger(entry.rows) || entry.rows < 0) {
      throw new Error('A relation snapshot entry does not match the approved contract.');
    }
    return { schema: entry.schema, table: entry.table, rows: entry.rows };
  });
  entries.sort((left, right) => {
    if (left.schema !== right.schema) return left.schema < right.schema ? -1 : 1;
    if (left.table !== right.table) return left.table < right.table ? -1 : 1;
    return 0;
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].schema === entries[index].schema &&
        entries[index - 1].table === entries[index].table) {
      throw new Error('A relation snapshot lists the same relation twice.');
    }
  }
  return entries;
}

// The digest is taken over exactly the bytes that are kept as evidence, so an
// auditor can reproduce the recorded hash with `sha256sum` on the stored
// snapshot instead of having to re-serialize the JSON the same way we did.
function serializeRelations(entries) {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function relationsDigest(entries) {
  return createHash('sha256').update(serializeRelations(entries)).digest('hex');
}

function totals(entries) {
  return {
    tables: entries.length,
    rows: entries.reduce((total, entry) => total + entry.rows, 0),
  };
}

function assertRelationsPreserved(before, after) {
  const known = new Map(after.map(entry => [`${entry.schema}\0${entry.table}`, entry.rows]));
  const missing = [];
  const shrunken = [];
  for (const entry of before) {
    const rows = known.get(`${entry.schema}\0${entry.table}`);
    if (rows === undefined) missing.push(`${entry.schema}.${entry.table}`);
    else if (rows < entry.rows) shrunken.push(`${entry.schema}.${entry.table} (${entry.rows} -> ${rows})`);
  }
  if (missing.length > 0) {
    throw new Error(`The migration removed relations that held data: ${missing.join(', ')}.`);
  }
  if (shrunken.length > 0) {
    throw new Error(`The migration lost rows in relations that existed before it: ${shrunken.join(', ')}.`);
  }
  const beforeTotals = totals(before);
  const afterTotals = totals(after);
  if (afterTotals.rows < beforeTotals.rows) {
    throw new Error('The migration reduced the total row count of the production database.');
  }
  return { beforeTotals, afterTotals };
}

function upgradeMigrationEvidence({
  releaseId, releaseContentSha256, migrationSetSha256, completedAt, predecessorReleaseId,
  preUpgradeBackupManifestFile, preUpgradeBackupSha256, relationsBefore, relationsAfter,
}) {
  if (!RELEASE_ID.test(releaseId || '') || !SHA256.test(releaseContentSha256 || '') ||
      !SHA256.test(migrationSetSha256 || '') || !SHA256.test(preUpgradeBackupSha256 || '') ||
      typeof completedAt !== 'string' || Number.isNaN(Date.parse(completedAt)) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(completedAt) ||
      !/^pawshop_production_[0-9]{8}T[0-9]{9}Z\.manifest\.json$/.test(preUpgradeBackupManifestFile || '')) {
    throw new Error('Upgrade migration evidence inputs are invalid.');
  }
  if (!RELEASE_ID.test(predecessorReleaseId || '') || predecessorReleaseId === releaseId) {
    throw new Error('Upgrade migration evidence must name the release it upgrades.');
  }
  const { beforeTotals, afterTotals } = assertRelationsPreserved(relationsBefore, relationsAfter);
  if (beforeTotals.tables < 1 || beforeTotals.rows < 1) {
    throw new Error('An upgrade requires an existing database with data to preserve.');
  }
  return {
    schema: 'pawshop-production-migration-v2',
    release_id: releaseId,
    release_content_sha256: releaseContentSha256,
    database: 'pawshop',
    initialization: 'existing-database',
    predecessor_release_id: predecessorReleaseId,
    pre_upgrade_backup_manifest_file: preUpgradeBackupManifestFile,
    pre_upgrade_backup_sha256: preUpgradeBackupSha256,
    relations_before_sha256: relationsDigest(relationsBefore),
    relations_after_sha256: relationsDigest(relationsAfter),
    tables_before: beforeTotals.tables,
    tables_after: afterTotals.tables,
    completed_at: completedAt,
    command: 'db:migrate',
    migration_set_sha256: migrationSetSha256,
    status: 'succeeded',
  };
}

module.exports = {
  assertRelationsPreserved,
  parseRelationsSnapshot,
  relationsDigest,
  serializeRelations,
  totals,
  upgradeMigrationEvidence,
};
