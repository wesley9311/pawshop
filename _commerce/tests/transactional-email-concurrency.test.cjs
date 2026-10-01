'use strict';

// Real-PostgreSQL concurrency integration test for the send-state machine.
//
// The mock test in transactional-email-service.test.cjs proves the *logic* of
// the state transitions, but it cannot prove the DB-level claim atomicity: that
// two independent connections racing to claim the same idempotency_key can
// never both win. This test drives the real service SQL (via knex) against an
// isolated throwaway Postgres and asserts the two concurrency guarantees:
//
//   1. Two concurrent tryClaim calls → exactly one `claim`, the other
//      `in_flight`, final attempt_count = 1, status = sending, one live lease.
//   2. Stale-lease recovery: once the lease expires, two workers recovering
//      concurrently still let exactly one re-claim, and attempt_count rises by
//      exactly 1.
//
// It is gated on PAWSHOP_TEST_DATABASE_URL (or a locally started test cluster);
// without it the suite is skipped, so `npm test` never accidentally hits a
// production or development database. It MUST NOT be pointed at the production
// transactional_email_sent table.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB_URL = process.env.PAWSHOP_TEST_DATABASE_URL || '';

let knexFactory;
let PawshopNotificationService;
try {
  knexFactory = require('knex');
  if (knexFactory && knexFactory.default) knexFactory = knexFactory.default;
  PawshopNotificationService = require('../.medusa/server/src/modules/pawshop-notification/service.js').default;
} catch (e) {
  knexFactory = null;
  PawshopNotificationService = null;
}

const PG_CONNECTION = '__pg_connection__';
const SEND_STATES = { PENDING: 'pending', SENDING: 'sending', SENT: 'sent', FAILED: 'failed', TERMINAL: 'terminal' };

// Build a service backed by its own knex connection pool. Two services built
// this way are fully independent at the driver level, exactly like two worker
// processes would be.
function makeService() {
  const knex = knexFactory({ client: 'pg', connection: TEST_DB_URL, pool: { min: 0, max: 1 } });
  const container = {
    baseRepository: { serialize: (x) => x },
    [PG_CONNECTION]: knex,
  };
  return { svc: new PawshopNotificationService(container), knex };
}

const TABLE = 'transactional_email_sent';
const TEST_KEY = 'order:order_int_1:order_confirmed';

describe('transactional-email service: real Postgres concurrency', () => {
  if (!knexFactory || !PawshopNotificationService) {
    it('is skipped because knex or the compiled service is unavailable', () => { assert.ok(true); });
    return;
  }

  let probe;
  let dbAvailable = false;

  before(async () => {
    if (!TEST_DB_URL) {
      dbAvailable = false;
      return;
    }
    probe = knexFactory({ client: 'pg', connection: TEST_DB_URL });
    try {
      await probe.raw('select 1');
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  after(async () => {
    if (probe) await probe.destroy().catch(() => undefined);
  });

  async function cleanTable() {
    await probe.raw(`delete from "${TABLE}"`);
  }

  async function rowState(key) {
    const r = await probe.raw(
      `select "status", "attempt_count", "lease_expires_at", "claimed_at" from "${TABLE}" where "idempotency_key" = ?`,
      [key],
    );
    return r.rows[0] || null;
  }

  function requireDb() {
    if (!dbAvailable) {
      // Skip rather than fail when no test database is reachable, so `npm test`
      // still passes in an environment without Postgres.
      return false;
    }
    return true;
  }

  it('gives exactly one claim to two concurrent workers', async (t) => {
    if (!requireDb()) { t.skip('no test database reachable'); return; }
    await cleanTable();
    const a = makeService();
    const b = makeService();
    const now = new Date();

    try {
      const [ra, rb] = await Promise.all([
        a.svc.tryClaim({ idempotencyKey: TEST_KEY, notificationType: 'order_confirmed', entityId: 'order_int_1', now }),
        b.svc.tryClaim({ idempotencyKey: TEST_KEY, notificationType: 'order_confirmed', entityId: 'order_int_1', now }),
      ]);

      const states = [ra.state, rb.state].sort();
      assert.deepEqual(states, ['claim', 'in_flight'], 'exactly one worker claims, the other is in_flight');

      const row = await rowState(TEST_KEY);
      assert.equal(row.status, SEND_STATES.SENDING, 'the row ends in sending');
      assert.equal(Number(row.attempt_count), 1, 'attempt_count is exactly 1');
      assert.ok(row.lease_expires_at, 'exactly one live lease is present');
    } finally {
      await a.knex.destroy().catch(() => undefined);
      await b.knex.destroy().catch(() => undefined);
    }
  });

  it('lets exactly one worker re-claim a stale lease, incrementing attempt_count by 1', async (t) => {
    if (!requireDb()) { t.skip('no test database reachable'); return; }
    await cleanTable();
    const seed = makeService();
    const now = new Date();

    // Seed a claimed row, then force its lease into the past to simulate a
    // worker that crashed mid-send.
    await seed.svc.tryClaim({ idempotencyKey: TEST_KEY, notificationType: 'order_confirmed', entityId: 'order_int_1', now });
    await seed.knex.destroy().catch(() => undefined);
    await probe.raw(
      `update "${TABLE}" set "lease_expires_at" = now() - interval '10 minutes' where "idempotency_key" = ?`,
      [TEST_KEY],
    );

    const a = makeService();
    const b = makeService();
    const later = new Date();
    try {
      const [ra, rb] = await Promise.all([
        a.svc.tryClaim({ idempotencyKey: TEST_KEY, notificationType: 'order_confirmed', entityId: 'order_int_1', now: later }),
        b.svc.tryClaim({ idempotencyKey: TEST_KEY, notificationType: 'order_confirmed', entityId: 'order_int_1', now: later }),
      ]);

      const states = [ra.state, rb.state].sort();
      assert.deepEqual(states, ['claim', 'in_flight'], 'only one worker re-claims the stale lease');

      const row = await rowState(TEST_KEY);
      assert.equal(Number(row.attempt_count), 2, 'attempt_count rose by exactly 1 (1 → 2), not by 2');
      assert.equal(row.status, SEND_STATES.SENDING);
    } finally {
      await a.knex.destroy().catch(() => undefined);
      await b.knex.destroy().catch(() => undefined);
    }
  });

  it('under heavy contention, exactly one of N workers claims (fresh event)', async (t) => {
    if (!requireDb()) { t.skip('no test database reachable'); return; }
    await cleanTable();
    const N = 8;
    const workers = Array.from({ length: N }, () => makeService());
    const now = new Date();
    try {
      const results = await Promise.all(workers.map((w) =>
        w.svc.tryClaim({ idempotencyKey: TEST_KEY, notificationType: 'order_confirmed', entityId: 'order_int_1', now }),
      ));

      const claims = results.filter((r) => r.state === 'claim');
      const nonClaims = results.filter((r) => r.state !== 'claim');
      assert.equal(claims.length, 1, 'exactly one of N workers claims');
      assert.equal(nonClaims.length, N - 1, 'the other N-1 workers do not claim');
      assert.ok(nonClaims.every((r) => r.state === 'in_flight'), 'all non-claim results are in_flight');

      const row = await rowState(TEST_KEY);
      assert.equal(Number(row.attempt_count), 1, 'attempt_count is exactly 1 despite N contenders');
      assert.equal(row.status, SEND_STATES.SENDING);
    } finally {
      for (const w of workers) await w.knex.destroy().catch(() => undefined);
    }
  });
});
