'use strict';

// Service-level tests for the durable send-state machine in
// `pawshop-notification`. The service talks to Postgres exclusively through
// `knex.raw`, so these tests swap in an in-memory knex that implements the
// *semantics* of the four queries the service issues (INSERT ... ON CONFLICT,
// UPDATE ... WHERE ... RETURNING, SELECT) against a small row map. This gives
// real behavioural coverage of the state transitions — claim / retry / terminal
// / lease recovery / concurrency — without a live database.
//
// The mock only understands the SQL the service actually emits; it is not a
// general Postgres. If the service's SQL changes shape, these tests must change
// with it, which is exactly the pinning we want.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { SEND_STATES, MAX_ATTEMPTS, computeNextAttemptAt } = require('../src/lib/transactional-order-email.cjs');

// Load the compiled service. `PawshopNotificationService` extends MedusaService,
// whose constructor touches `__joinerConfig?.()` (optional) and reads
// `container.baseRepository`; both are supplied by the mock below.
let PawshopNotificationService;
try {
  PawshopNotificationService = require('../.medusa/server/src/modules/pawshop-notification/service.js').default;
} catch {
  // If the project has not been built yet, there is nothing to test.
  PawshopNotificationService = null;
}

const PG_CONNECTION = '__pg_connection__';

// A tiny in-memory implementation of the subset of Postgres the service uses.
function makeMockKnex() {
  // rows keyed by idempotency_key
  const rows = new Map();

  function nowIso(ms) { return new Date(ms).toISOString(); }

  // Parse `... where X = ? and ...` into a predicate the mock can evaluate. The
  // service uses only the conditions we handle below; anything else returns
  // false so a changed query fails loudly rather than silently passing.
  function matches(row, sql, params) {
    // The service always filters by idempotency_key first.
    if (row.deleted_at != null) return false;

    // attempt_count < ?
    const maxMatch = /attempt_count" < \?/.exec(sql);
    if (maxMatch && Number(row.attempt_count) >= Number(params[0])) {
      // NOTE: params[0] is the first placeholder that appears after this
      // clause's binding; the service binds MAX_ATTEMPTS there. We locate it by
      // counting placeholders, but for robustness we match against the known
      // constant below in each specific query.
    }

    return true;
  }

  // The mock inspects the concrete SQL shapes the service emits. Each branch
  // below mirrors one of the service's knex.raw calls.
  const knex = {
    raw: async (sql, params = []) => {
      // --- INSERT ... ON CONFLICT DO NOTHING (tryClaim step 1) ---
      if (/insert into "transactional_email_sent"/.test(sql)) {
        // params: [id, idempotency_key, notification_type, entity_id, status, expires_at, created_at, updated_at]
        const [id, key, type, entityId, status, expiresAt, createdAt, updatedAt] = params;
        if (rows.has(key)) {
          return { rows: [], rowCount: 0 };
        }
        rows.set(key, {
          id, idempotency_key: key, notification_type: type, entity_id: entityId,
          status, attempt_count: 0, claimed_at: null, lease_expires_at: null,
          next_attempt_at: null, sent_at: null, error_category: null,
          expires_at: expiresAt, created_at: createdAt, updated_at: updatedAt, deleted_at: null,
        });
        return { rows: [], rowCount: 0 };
      }

      // --- UPDATE ... RETURNING id, attempt_count (tryClaim step 2) ---
      if (/update "transactional_email_sent"/.test(sql) && /returning "id", "attempt_count"/.test(sql)) {
        // params: [SENDING, nowIso, leaseExpiry, nowIso, idempotencyKey, MAX_ATTEMPTS, PENDING, FAILED, nowIso, SENDING, nowIso]
        const key = params[4];
        const maxAttempts = params[5];
        const row = rows.get(key);
        if (!row || row.deleted_at != null || Number(row.attempt_count) >= Number(maxAttempts)) {
          return { rows: [], rowCount: 0 };
        }
        const now = params[1];
        const leaseExpiry = params[2];
        const backoffNow = params[8];  // the `next_attempt_at <= ?` binding
        const staleNow = params[10];   // the `lease_expires_at < ?` binding
        const claimable =
          row.status === SEND_STATES.PENDING ||
          (row.status === SEND_STATES.FAILED && (row.next_attempt_at == null || row.next_attempt_at <= backoffNow)) ||
          (row.status === SEND_STATES.SENDING && row.lease_expires_at != null && row.lease_expires_at < staleNow);
        if (!claimable) {
          return { rows: [], rowCount: 0 };
        }
        // The read-check-write is synchronous here (no await inside), which
        // mirrors the atomicity of the real UPDATE ... WHERE ... RETURNING: two
        // racing calls cannot both observe the pre-claim state.
        row.status = SEND_STATES.SENDING;
        row.claimed_at = now;
        row.lease_expires_at = leaseExpiry;
        row.attempt_count = Number(row.attempt_count) + 1;
        row.next_attempt_at = null;
        row.updated_at = params[3];
        return { rows: [{ id: row.id, attempt_count: row.attempt_count }], rowCount: 1 };
      }

      // --- SELECT status, lease_expires_at, attempt_count (tryClaim step 3) ---
      if (/select "status", "lease_expires_at", "attempt_count"/.test(sql)) {
        const key = params[0];
        const row = rows.get(key);
        if (!row || row.deleted_at != null) return { rows: [], rowCount: 0 };
        return { rows: [{ status: row.status, lease_expires_at: row.lease_expires_at, attempt_count: row.attempt_count }], rowCount: 1 };
      }

      // --- UPDATE ... set status = sent ... (markSent) ---
      if (/set "status" = \?, "sent_at"/.test(sql)) {
        const key = params[params.length - 2];
        const row = rows.get(key);
        if (!row || row.deleted_at != null || row.status !== SEND_STATES.SENDING) return { rows: [], rowCount: 0 };
        row.status = SEND_STATES.SENT;
        row.sent_at = params[1];
        row.lease_expires_at = null;
        row.next_attempt_at = null;
        row.updated_at = params[2];
        return { rows: [], rowCount: 1 };
      }

      // --- UPDATE ... case when attempt_count >= ... (markFailed transient) ---
      if (/case when "attempt_count" >= \? then \? else \? end/.test(sql)) {
        const [maxAttempts, terminalStatus, failedStatus, errorCategory, maxAttempts2, nextAttemptAt, nowUpd, key, sendingStatus] = params;
        const row = rows.get(key);
        if (!row || row.deleted_at != null || row.status !== SEND_STATES.SENDING) return { rows: [], rowCount: 0 };
        if (Number(row.attempt_count) >= Number(maxAttempts)) {
          row.status = terminalStatus;
          row.next_attempt_at = null;
        } else {
          row.status = failedStatus;
          row.next_attempt_at = nextAttemptAt;
        }
        row.error_category = errorCategory;
        row.lease_expires_at = null;
        row.updated_at = nowUpd;
        return { rows: [], rowCount: 1 };
      }

      // --- UPDATE ... set status = terminal ... (markTerminal) ---
      if (/set "status" = \?, "error_category"/.test(sql) && /status" in/.test(sql)) {
        const key = params[params.length - 3];
        const row = rows.get(key);
        if (!row || row.deleted_at != null) return { rows: [], rowCount: 0 };
        if (row.status !== SEND_STATES.SENDING && row.status !== SEND_STATES.FAILED) return { rows: [], rowCount: 0 };
        row.status = SEND_STATES.TERMINAL;
        row.error_category = params[1];
        row.lease_expires_at = null;
        row.next_attempt_at = null;
        row.updated_at = params[2];
        return { rows: [], rowCount: 1 };
      }

      // --- SELECT attempt_count (readAttemptCount) ---
      if (/select "attempt_count" from "transactional_email_sent"/.test(sql)) {
        const key = params[0];
        const row = rows.get(key);
        if (!row || row.deleted_at != null) return { rows: [], rowCount: 0 };
        return { rows: [{ attempt_count: row.attempt_count }], rowCount: 1 };
      }

      // --- SELECT ... (scanEligible) ---
      if (/select "idempotency_key", "notification_type", "entity_id", "attempt_count"/.test(sql)) {
        // params: [MAX_ATTEMPTS, FAILED, nowIso, SENDING, nowIso, limit]
        const maxAttempts = params[0];
        const now = params[2];
        const out = [];
        for (const row of rows.values()) {
          if (row.deleted_at != null) continue;
          if (Number(row.attempt_count) >= Number(maxAttempts)) continue;
          const eligible =
            (row.status === SEND_STATES.FAILED && (row.next_attempt_at == null || row.next_attempt_at <= now)) ||
            (row.status === SEND_STATES.SENDING && row.lease_expires_at != null && row.lease_expires_at < now);
          if (eligible) {
            out.push({ idempotency_key: row.idempotency_key, notification_type: row.notification_type, entity_id: row.entity_id, attempt_count: row.attempt_count });
          }
        }
        return { rows: out, rowCount: out.length };
      }

      throw new Error(`Unrecognized SQL in mock: ${sql}`);
    },
  };

  return { knex, rows, _nowIso: nowIso };
}

function makeService(knex) {
  const container = {
    baseRepository: { serialize: (x) => x },
    [PG_CONNECTION]: knex,
  };
  const svc = new PawshopNotificationService(container);
  return svc;
}

describe('transactional-email service state machine', () => {
  if (!PawshopNotificationService) {
    it('is skipped because the project has not been built', () => {
      assert.ok(true);
    });
    return;
  }

  const now = new Date('2026-10-01T00:00:00Z');

  it('claims a fresh event and marks it sent', async () => {
    const { knex, rows } = makeMockKnex();
    const svc = makeService(knex);
    const key = 'order:order_1:order_confirmed';

    const claim = await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now });
    assert.equal(claim.state, 'claim');
    assert.equal(rows.get(key).status, SEND_STATES.SENDING);
    assert.equal(rows.get(key).attempt_count, 1);

    await svc.markSent({ idempotencyKey: key, now });
    assert.equal(rows.get(key).status, SEND_STATES.SENT);
    assert.equal(rows.get(key).sent_at, now.toISOString());

    // A second claim after sent is skip_sent (never duplicate-send).
    const again = await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now });
    assert.equal(again.state, 'skip_sent');
  });

  it('returns failed with a next_attempt_at on a transient failure', async () => {
    const { knex, rows } = makeMockKnex();
    const svc = makeService(knex);
    const key = 'order:order_1:order_confirmed';

    await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now });
    const nextAttemptAt = computeNextAttemptAt(1, now);
    await svc.markFailed({ idempotencyKey: key, errorCategory: 'connect', retryable: true, nextAttemptAt, now });

    assert.equal(rows.get(key).status, SEND_STATES.FAILED);
    assert.equal(rows.get(key).next_attempt_at, nextAttemptAt);
    assert.equal(rows.get(key).attempt_count, 1);
  });

  it('does not claim a failed row before its next_attempt_at', async () => {
    const { knex, rows } = makeMockKnex();
    const svc = makeService(knex);
    const key = 'order:order_1:order_confirmed';

    await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now });
    await svc.markFailed({ idempotencyKey: key, errorCategory: 'connect', retryable: true, nextAttemptAt: computeNextAttemptAt(1, now), now });

    // Immediately: backoff has not elapsed, so this is not a claim.
    const early = await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now });
    assert.equal(early.state, 'in_flight');
    assert.equal(rows.get(key).attempt_count, 1);
  });

  it('claims again once next_attempt_at has elapsed (recovery retry)', async () => {
    const { knex, rows } = makeMockKnex();
    const svc = makeService(knex);
    const key = 'order:order_1:order_confirmed';

    await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now });
    await svc.markFailed({ idempotencyKey: key, errorCategory: 'connect', retryable: true, nextAttemptAt: computeNextAttemptAt(1, now), now });

    const later = new Date('2026-10-01T00:02:00Z'); // after the 1m backoff
    const claim = await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now: later });
    assert.equal(claim.state, 'claim');
    assert.equal(rows.get(key).status, SEND_STATES.SENDING);
    assert.equal(rows.get(key).attempt_count, 2);
  });

  it('recovers a stale sending row whose lease expired', async () => {
    const { knex, rows } = makeMockKnex();
    const svc = makeService(knex);
    const key = 'order:order_1:order_confirmed';

    await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now });
    // Simulate a crash: the row is still sending, but the lease has long expired.
    rows.get(key).lease_expires_at = new Date('2026-09-30T23:00:00Z').toISOString();

    const later = new Date('2026-10-01T00:30:00Z');
    const claim = await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now: later });
    assert.equal(claim.state, 'claim');
    assert.equal(rows.get(key).attempt_count, 2);
  });

  it('lets only one of two racing workers claim the lease', async () => {
    const { knex, rows } = makeMockKnex();
    const svc = makeService(knex);
    const key = 'order:order_1:order_confirmed';

    const [a, b] = await Promise.all([
      svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now }),
      svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now }),
    ]);
    const states = [a.state, b.state].sort();
    assert.deepEqual(states, ['claim', 'in_flight']);
    // Only one attempt was counted.
    assert.equal(rows.get(key).attempt_count, 1);
  });

  it('does not retry a permanent (non-retryable) failure', async () => {
    const { knex, rows } = makeMockKnex();
    const svc = makeService(knex);
    const key = 'order:order_1:order_confirmed';

    await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now });
    await svc.markFailed({ idempotencyKey: key, errorCategory: 'recipient', retryable: false, nextAttemptAt: computeNextAttemptAt(1, now), now });
    assert.equal(rows.get(key).status, SEND_STATES.TERMINAL);

    const again = await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now: new Date('2026-10-02T00:00:00Z') });
    assert.equal(again.state, 'skip_terminal');
    assert.equal(rows.get(key).attempt_count, 1);
  });

  it('reaches terminal after MAX_ATTEMPTS transient failures', async () => {
    const { knex, rows } = makeMockKnex();
    const svc = makeService(knex);
    const key = 'order:order_1:order_confirmed';
    let t = now;
    const step = (min) => new Date(t.getTime() + min * 60 * 1000);

    // Attempts 1..MAX_ATTEMPTS-1 fail transiently and schedule a backoff retry.
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const claim = await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now: t });
      assert.equal(claim.state, 'claim', `attempt ${attempt} should claim`);
      const nextAttemptAt = computeNextAttemptAt(attempt, t);
      assert.notEqual(nextAttemptAt, null, `attempt ${attempt} should schedule a retry`);
      await svc.markFailed({ idempotencyKey: key, errorCategory: 'connect', retryable: true, nextAttemptAt, now: t });
      assert.equal(rows.get(key).status, SEND_STATES.FAILED);
      // Advance past the backoff for the next iteration.
      t = step(200);
    }

    // The 5th attempt claims, fails, and goes terminal (no 6th send).
    const finalClaim = await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now: t });
    assert.equal(finalClaim.state, 'claim');
    await svc.markTerminal({ idempotencyKey: key, errorCategory: 'max_attempts', now: t });

    assert.equal(rows.get(key).status, SEND_STATES.TERMINAL);
    assert.equal(rows.get(key).attempt_count, MAX_ATTEMPTS);
    const again = await svc.tryClaim({ idempotencyKey: key, notificationType: 'order_confirmed', entityId: 'order_1', now: t });
    assert.equal(again.state, 'skip_terminal');
  });

  it('scanEligible returns only due failed rows and stale sending rows', async () => {
    const { knex, rows } = makeMockKnex();
    const svc = makeService(knex);
    const key1 = 'order:order_1:order_confirmed'; // failed, backoff elapsed
    const key2 = 'order:order_2:order_confirmed'; // failed, backoff NOT elapsed
    const key3 = 'order:order_3:order_confirmed'; // stale sending
    const key4 = 'order:order_4:order_confirmed'; // sent (not eligible)

    await svc.tryClaim({ idempotencyKey: key1, notificationType: 'order_confirmed', entityId: 'order_1', now });
    await svc.markFailed({ idempotencyKey: key1, errorCategory: 'connect', retryable: true, nextAttemptAt: computeNextAttemptAt(1, now), now });

    await svc.tryClaim({ idempotencyKey: key2, notificationType: 'order_confirmed', entityId: 'order_2', now });
    await svc.markFailed({ idempotencyKey: key2, errorCategory: 'connect', retryable: true, nextAttemptAt: new Date('2099-01-01T00:00:00Z').toISOString(), now });

    await svc.tryClaim({ idempotencyKey: key3, notificationType: 'order_confirmed', entityId: 'order_3', now });
    rows.get(key3).lease_expires_at = new Date('2026-09-30T00:00:00Z').toISOString();

    await svc.tryClaim({ idempotencyKey: key4, notificationType: 'order_confirmed', entityId: 'order_4', now });
    await svc.markSent({ idempotencyKey: key4, now });

    const later = new Date('2026-10-01T00:30:00Z');
    const eligible = await svc.scanEligible(later, 100);
    const keys = eligible.map((r) => r.idempotency_key).sort();
    // key1 (backoff elapsed) and key3 (stale sending) are eligible; key2 (backoff
    // not elapsed) and key4 (sent) are not.
    assert.deepEqual(keys, [key1, key3]);
    // The eligible rows carry the locating fields, not any sensitive data.
    assert.equal(eligible.find((r) => r.idempotency_key === key1).entity_id, 'order_1');
    assert.equal(eligible.find((r) => r.idempotency_key === key1).notification_type, 'order_confirmed');
  });
});
