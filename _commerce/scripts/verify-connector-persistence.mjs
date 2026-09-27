// Persistence acceptance for the PawShop Connector module.
//
// Runs the module's OWN migration against a real PostgreSQL engine and then
// asserts the constraint semantics the connector's guarantees rest on:
//
//   * the replay guard is a unique index, not application logic
//   * the idempotency claim is a unique index — that is the mutex that stops a
//     concurrent duplicate from creating a second product
//   * the stable external product id is a unique index
//   * the migration touches only the connector's own tables
//
// The engine is PGlite (PostgreSQL compiled to WASM), so this needs no server.
// PGlite is deliberately NOT a dependency of this project: install it wherever
// convenient and point PGLITE_PATH at it, or let the bare specifier resolve.
//
// USAGE
//   cd _commerce
//   node node_modules/typescript/bin/tsc            # produce .medusa/server
//   npm i --no-save @electric-sql/pglite            # or install elsewhere
//   node scripts/verify-connector-persistence.mjs
//
//   # or, with PGlite in a scratch directory:
//   PGLITE_PATH=/path/to/node_modules/@electric-sql/pglite/dist/index.js \
//     node scripts/verify-connector-persistence.mjs

import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const compiledRoot = resolve(process.argv[2] || join(root, '.medusa', 'server'))
const migrationsDir = join(compiledRoot, 'src', 'modules', 'pawshop-connector', 'migrations')

async function loadPGlite() {
  const candidates = [process.env.PGLITE_PATH, '@electric-sql/pglite'].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const module = await import(candidate.startsWith('/') ? candidate : candidate)
      if (module.PGlite) return module.PGlite
    } catch {
      // try the next candidate
    }
  }
  process.stdout.write(
    'SKIPPED: PGlite is not installed.\n' +
      'Install it (it is intentionally not a dependency of this project), e.g.:\n' +
      '  npm i --no-save @electric-sql/pglite\n' +
      'or set PGLITE_PATH to its dist/index.js.\n'
  )
  process.exit(0)
}

// The migration classes follow Medusa's `Migration<timestamp>` naming; run every
// one found, in order, so a future second migration is covered automatically.
const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => /^Migration\d+\.js$/.test(name))
  .sort()
if (migrationFiles.length === 0) {
  process.stderr.write(`No compiled migrations found in ${migrationsDir}. Run tsc first.\n`)
  process.exit(1)
}

async function collect(instance, direction) {
  const statements = []
  instance.addSql = (sql) => statements.push(sql)
  await instance[direction]()
  return statements
}

const upStatements = []
const downStatements = []
for (const file of migrationFiles) {
  const module = require(join(migrationsDir, file))
  const MigrationClass = Object.values(module).find((value) => typeof value === 'function')
  const instance = Object.create(MigrationClass.prototype)
  upStatements.push(...(await collect(instance, 'up')))
  const downInstance = Object.create(MigrationClass.prototype)
  downStatements.push(...(await collect(downInstance, 'down')))
}

const PGlite = await loadPGlite()
const db = new PGlite()
let failures = 0
let total = 0

async function check(label, fn) {
  total += 1
  try {
    await fn()
    process.stdout.write(`ok   - ${label}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`FAIL - ${label}: ${error.message}\n`)
  }
}

async function expectError(label, sql) {
  total += 1
  try {
    await db.exec(sql)
    failures += 1
    process.stdout.write(`FAIL - ${label}: expected an error, got none\n`)
  } catch (error) {
    process.stdout.write(`ok   - ${label} -> ${String(error.message).split('\n')[0].slice(0, 70)}\n`)
  }
}

for (const sql of upStatements) await db.exec(sql)
process.stdout.write(
  `\nMIGRATION: ${upStatements.length} statements from ${migrationFiles.length} file(s) executed against Postgres\n\n`
)

await check('exactly the four connector tables exist', async () => {
  const result = await db.query(
    "select table_name from information_schema.tables where table_name like 'connector_%' order by table_name"
  )
  const names = result.rows.map((row) => row.table_name)
  const expected = [
    'connector_audit_event',
    'connector_idempotency_record',
    'connector_product_mapping',
    'connector_replay_nonce',
  ]
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('got ' + names.join(','))
})

await check('no other table exists in public (core commerce is untouched)', async () => {
  const result = await db.query(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name not like 'connector_%'"
  )
  if (result.rows[0].n !== 0) throw new Error('unexpected extra tables: ' + result.rows[0].n)
})

await check('the migration is re-runnable (idempotent DDL)', async () => {
  for (const sql of upStatements) await db.exec(sql)
})

await check('every expected index and primary key exists', async () => {
  const result = await db.query(
    "select indexname from pg_indexes where tablename like 'connector_%' order by indexname"
  )
  const names = result.rows.map((row) => row.indexname)
  const expected = [
    'IDX_connector_audit_event_idempotency_key',
    'IDX_connector_audit_event_occurred_at',
    'IDX_connector_audit_event_source_product_id',
    'IDX_connector_idempotency_record_expires_at',
    'IDX_connector_idempotency_record_key_unique',
    'IDX_connector_product_mapping_product_id',
    'IDX_connector_product_mapping_source_product_id_unique',
    'IDX_connector_replay_nonce_expires_at',
    'IDX_connector_replay_nonce_key_unique',
    'connector_audit_event_pkey',
    'connector_idempotency_record_pkey',
    'connector_product_mapping_pkey',
    'connector_replay_nonce_pkey',
  ]
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('got ' + names.join(' | '))
})

const nonce = (id, keyId, value) =>
  "insert into connector_replay_nonce (id, key_id, nonce, claimed_at, expires_at) values ('" +
  id + "','" + keyId + "','" + value + "', now(), now() + interval '5 minutes');"

await check('the first nonce claim is accepted', async () => {
  await db.exec(nonce('n1', 'key-a', 'nonce-1'))
})
await expectError('a replayed (key_id, nonce) pair is refused', nonce('n2', 'key-a', 'nonce-1'))
await check('a different key_id may reuse the same nonce text', async () => {
  await db.exec(nonce('n3', 'key-b', 'nonce-1'))
})

const IDEMPOTENCY_KEY = 'cloudgull:pawshop:product:CG-1001:r3'
const idempotency = (id, sha) =>
  "insert into connector_idempotency_record (id, idempotency_key, key_id, source_product_id, product_id, response_status, response_body, request_body_sha256, expires_at) values ('" +
  id + "','" + IDEMPOTENCY_KEY + "','key-a','CG-1001','prod_1',0,'{}'::jsonb,'" + sha +
  "', now() + interval '90 days');"

await check('an idempotency claim (in-flight sentinel) is accepted', async () => {
  await db.exec(idempotency('i1', 'sha-a'))
})
await expectError(
  'a concurrent claim on the same key is refused (this is the mutex)',
  idempotency('i2', 'sha-a')
)
await check('completing the claim stores the real response', async () => {
  await db.exec(
    "update connector_idempotency_record set response_status=201, response_body='{\"productId\":\"prod_1\",\"version\":\"ps-r3\",\"created\":true,\"replayed\":false}'::jsonb where id='i1';"
  )
})
await check('the stored response replays verbatim', async () => {
  const result = await db.query(
    "select response_status, response_body from connector_idempotency_record where idempotency_key='" +
      IDEMPOTENCY_KEY + "'"
  )
  const row = result.rows[0]
  if (row.response_status !== 201 || row.response_body.productId !== 'prod_1') {
    throw new Error(JSON.stringify(row))
  }
})

await check('the stable product mapping is accepted', async () => {
  await db.exec(
    "insert into connector_product_mapping (id, source_product_id, product_id, handle, last_revision, external_version) values ('m1','CG-1001','prod_1','h',3,'ps-r3');"
  )
})
await expectError(
  'a second mapping for the same source product is refused (stable external id)',
  "insert into connector_product_mapping (id, source_product_id, product_id, handle, last_revision, external_version) values ('m2','CG-1001','prod_2','h2',4,'ps-r4');"
)

await check('a soft-deleted row releases its partial unique index', async () => {
  await db.exec("update connector_replay_nonce set deleted_at = now() where id='n1';")
  await db.exec(nonce('n4', 'key-a', 'nonce-1'))
})

await check('an audit row accepts a rejected entry with no known subject', async () => {
  await db.exec(
    "insert into connector_audit_event (id, occurred_at, method, path, outcome, http_status, error_code, duration_ms) values ('a1', now(), 'PUT', '/api/connector/v1/products/CG-1001', 'rejected', 401, 'AUTH_HEADERS_REQUIRED', 2);"
  )
})

for (const sql of downStatements) await db.exec(sql)
await check('down() removes exactly the connector tables', async () => {
  const result = await db.query(
    "select count(*)::int as n from information_schema.tables where table_name like 'connector_%'"
  )
  if (result.rows[0].n !== 0) throw new Error('left ' + result.rows[0].n + ' tables')
})

await db.close()
process.stdout.write(`\n${total} checks, ${failures} failure(s)\n`)
process.stdout.write(failures === 0 ? 'PERSISTENCE ACCEPTANCE PASSED\n' : 'PERSISTENCE ACCEPTANCE FAILED\n')
process.exit(failures === 0 ? 0 : 1)
