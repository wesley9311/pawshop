'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LOOKUP_FULFILLMENT_FIELDS,
  LOOKUP_NOT_FOUND_STATUS,
  LOOKUP_NOT_FOUND_BODY,
  buildPublicOrderNumber,
  parseOrderNumberInput,
  isLookupEmail,
  mapFulfillments,
} = require('../src/lib/order-lookup.cjs');

const ROUTE_PATH = path.join(
  __dirname, '..', 'src', 'api', 'store', 'pawshop-orders', 'lookup', 'route.ts',
);
const routeSource = fs.readFileSync(ROUTE_PATH, 'utf8');

// ---------- order number parsing ----------

test('every human-typed order number form reduces to the same display_id', () => {
  for (const input of ['6', ' #6 ', '#6', 'PS-20260929-0006', 'ps-20260929-0006'.toUpperCase()]) {
    assert.equal(parseOrderNumberInput(input), 6, `${JSON.stringify(input)} → 6`);
  }
  assert.equal(parseOrderNumberInput('0007'), 7);
});

test('an order number that cannot be a positive integer is rejected', () => {
  for (const bad of ['', '   ', 'abc', '0', '-1', '1.5', '6a', 'PS-20260929-0000', 'PS-abc', 'nan']) {
    assert.equal(parseOrderNumberInput(bad), null, `${JSON.stringify(bad)} → null`);
  }
});

test('a non-string order number is rejected without throwing', () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.equal(parseOrderNumberInput(value), null);
  }
});

test('the public order number is derived from real data and never truncated', () => {
  assert.equal(buildPublicOrderNumber(6, '2026-09-29T14:03:00.000Z'), 'PS-20260929-0006');
  // Zero-padded to 4 digits, and larger display_ids pass through intact.
  assert.equal(buildPublicOrderNumber(1, '2026-01-02T00:00:00.000Z'), 'PS-20260102-0001');
  assert.equal(buildPublicOrderNumber(12345, '2026-12-31T23:59:59.000Z'), 'PS-20261231-12345');
});

// ---------- email gate ----------

test('the email gate accepts normal addresses and rejects malformed ones', () => {
  assert.equal(isLookupEmail('buyer@example.com'), true);
  assert.equal(isLookupEmail('  Buyer@Example.COM  '), true);
  for (const bad of ['', 'buyer', 'buyer@', '@example.com', 'buyer@example', 'a b@example.com']) {
    assert.equal(isLookupEmail(bad), false, `${JSON.stringify(bad)} → false`);
  }
  assert.equal(isLookupEmail(null), false);
});

// ---------- fulfillment mapping ----------

function fulfillment(overrides = {}) {
  return {
    id: 'ful_1',
    created_at: '2026-09-29T10:00:00.000Z',
    packed_at: null,
    shipped_at: null,
    delivered_at: null,
    canceled_at: null,
    labels: [],
    ...overrides,
  };
}

test('an order with no fulfillment yields an empty array, never a placeholder', () => {
  assert.deepEqual(mapFulfillments(null), []);
  assert.deepEqual(mapFulfillments(undefined), []);
  assert.deepEqual(mapFulfillments([]), []);
  assert.deepEqual(mapFulfillments('ful_1'), []);
});

test('a packed-but-not-shipped fulfillment carries packed_at and no shipped_at', () => {
  const [mapped] = mapFulfillments([
    fulfillment({ packed_at: '2026-09-29T11:00:00.000Z' }),
  ]);
  assert.equal(mapped.packed_at, '2026-09-29T11:00:00.000Z');
  assert.equal(mapped.shipped_at, null);
  assert.equal(mapped.delivered_at, null);
  assert.equal(mapped.canceled_at, null);
  assert.deepEqual(mapped.labels, []);
});

test('timestamps the server was not given stay null rather than being invented', () => {
  const [mapped] = mapFulfillments([fulfillment({ packed_at: null, shipped_at: null })]);
  assert.equal(mapped.packed_at, null);
  assert.equal(mapped.shipped_at, null);
});

test('a shipped fulfillment exposes its real tracking number and url', () => {
  const [mapped] = mapFulfillments([
    fulfillment({
      shipped_at: '2026-09-30T08:00:00.000Z',
      labels: [{ tracking_number: '1Z999AA10123456784', tracking_url: 'https://carrier.example/track/1Z999' }],
    }),
  ]);
  assert.equal(mapped.labels.length, 1);
  assert.equal(mapped.labels[0].tracking_number, '1Z999AA10123456784');
  assert.equal(mapped.labels[0].tracking_url, 'https://carrier.example/track/1Z999');
});

test('a label with no url still reports the number, and vice versa', () => {
  const [noUrl] = mapFulfillments([fulfillment({ labels: [{ tracking_number: 'AB123' }] })]);
  assert.equal(noUrl.labels[0].tracking_number, 'AB123');
  assert.equal(noUrl.labels[0].tracking_url, null);

  const [noNumber] = mapFulfillments([fulfillment({ labels: [{ tracking_url: 'https://c.example/t' }] })]);
  assert.equal(noNumber.labels[0].tracking_number, null);
  assert.equal(noNumber.labels[0].tracking_url, 'https://c.example/t');
});

test('empty-string label values collapse to null instead of leaking ""', () => {
  const [mapped] = mapFulfillments([
    fulfillment({ labels: [{ tracking_number: '', tracking_url: '' }] }),
  ]);
  assert.equal(mapped.labels[0].tracking_number, null);
  assert.equal(mapped.labels[0].tracking_url, null);
});

test('label_url never crosses the wire, even when the query returns it', () => {
  const [mapped] = mapFulfillments([
    fulfillment({
      labels: [{
        tracking_number: 'AB123',
        tracking_url: 'https://carrier.example/track/AB123',
        // The warehouse's printable label artifact — must not be forwarded.
        label_url: 'https://internal.example/labels/AB123.pdf',
      }],
    }),
  ]);
  assert.deepEqual(Object.keys(mapped.labels[0]).sort(), ['tracking_number', 'tracking_url']);
  assert.equal(JSON.stringify(mapped).includes('label_url'), false);
  assert.equal(JSON.stringify(mapped).includes('internal.example'), false);
});

test('multiple fulfillments are returned oldest-first, all of them', () => {
  const mapped = mapFulfillments([
    fulfillment({ id: 'ful_late', created_at: '2026-10-02T00:00:00.000Z', packed_at: '2026-10-02T01:00:00.000Z' }),
    fulfillment({ id: 'ful_first', created_at: '2026-09-29T00:00:00.000Z', packed_at: '2026-09-29T01:00:00.000Z' }),
    fulfillment({ id: 'ful_mid', created_at: '2026-09-30T00:00:00.000Z', packed_at: '2026-09-30T01:00:00.000Z' }),
  ]);
  assert.deepEqual(mapped.map((f) => f.id), ['ful_first', 'ful_mid', 'ful_late']);
});

test('partially shipped orders keep each package own state', () => {
  const mapped = mapFulfillments([
    fulfillment({
      id: 'ful_old', created_at: '2026-09-29T00:00:00.000Z',
      packed_at: '2026-09-29T01:00:00.000Z', shipped_at: '2026-09-29T02:00:00.000Z',
      labels: [{ tracking_number: 'OLD1', tracking_url: 'https://c.example/OLD1' }],
    }),
    fulfillment({
      id: 'ful_new', created_at: '2026-09-30T00:00:00.000Z',
      packed_at: '2026-09-30T01:00:00.000Z',
    }),
  ]);
  assert.equal(mapped[0].shipped_at, '2026-09-29T02:00:00.000Z');
  assert.equal(mapped[0].labels[0].tracking_number, 'OLD1');
  assert.equal(mapped[1].shipped_at, null);
  assert.deepEqual(mapped[1].labels, []);
});

test('a delivered fulfillment keeps all three real timestamps', () => {
  const [mapped] = mapFulfillments([
    fulfillment({
      packed_at: '2026-09-29T01:00:00.000Z',
      shipped_at: '2026-09-29T02:00:00.000Z',
      delivered_at: '2026-10-01T09:00:00.000Z',
    }),
  ]);
  assert.equal(mapped.packed_at, '2026-09-29T01:00:00.000Z');
  assert.equal(mapped.shipped_at, '2026-09-29T02:00:00.000Z');
  assert.equal(mapped.delivered_at, '2026-10-01T09:00:00.000Z');
});

test('a canceled fulfillment reports canceled_at', () => {
  const [mapped] = mapFulfillments([
    fulfillment({ packed_at: '2026-09-29T01:00:00.000Z', canceled_at: '2026-09-29T05:00:00.000Z' }),
  ]);
  assert.equal(mapped.canceled_at, '2026-09-29T05:00:00.000Z');
});

test('malformed fulfillment/label entries are dropped, not rendered as blanks', () => {
  const mapped = mapFulfillments([null, { id: 'ful_ok', created_at: '2026-09-29T00:00:00.000Z' }, undefined]);
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].id, 'ful_ok');

  const [withJunkLabels] = mapFulfillments([fulfillment({ labels: [null, 'x', { tracking_number: 'OK' }] })]);
  assert.equal(withJunkLabels.labels.length, 1);
  assert.equal(withJunkLabels.labels[0].tracking_number, 'OK');
});

test('date values are serialized as-is and never reformatted or localised', () => {
  const [mapped] = mapFulfillments([fulfillment({ created_at: '2026-09-29T10:00:00.000Z' })]);
  assert.equal(mapped.created_at, '2026-09-29T10:00:00.000Z');
});

// ---------- the field whitelist ----------

test('the fulfillment field whitelist is exactly the real, buyer-visible columns', () => {
  assert.deepEqual(LOOKUP_FULFILLMENT_FIELDS, [
    'fulfillments.id',
    'fulfillments.created_at',
    'fulfillments.packed_at',
    'fulfillments.shipped_at',
    'fulfillments.delivered_at',
    'fulfillments.canceled_at',
    'fulfillments.labels.tracking_number',
    'fulfillments.labels.tracking_url',
  ]);
  // The warehouse label artifact is not on the list, and there is no `carrier`
  // column in Medusa to request in the first place.
  assert.ok(LOOKUP_FULFILLMENT_FIELDS.every((f) => !f.includes('label_url')));
  assert.equal(LOOKUP_FULFILLMENT_FIELDS.some((f) => f.endsWith('carrier')), false);
});

// ---------- route contract ----------

test('the route serializes fulfillments through the shared mapper', () => {
  assert.match(routeSource, /mapFulfillments\(order\.fulfillments\)/);
  assert.match(routeSource, /from '\.\.\/\.\.\/\.\.\/\.\.\/lib\/order-lookup\.cjs'/);
});

test('the route requests the fulfillment whitelist and nothing else', () => {
  assert.match(routeSource, /\.\.\.LOOKUP_FULFILLMENT_FIELDS/);
  // No fulfillment fields are hardcoded in the route: the whitelist is the one
  // source of truth, so `label_url` cannot slip in via a literal.
  const hardcoded = routeSource.match(/'fulfillments\.[a-z_.]*'/g) || [];
  assert.deepEqual(hardcoded, []);
});

test('every failure path in the route returns the identical 404 body', () => {
  const statuses = routeSource.match(/res\.status\(([^)]*)\)/g) || [];
  assert.ok(statuses.length >= 8, `expected the known response paths, saw ${statuses.length}`);
  for (const call of statuses) {
    const isSuccess = call === 'res.status(200)';
    const isNotFound = call === 'res.status(LOOKUP_NOT_FOUND_STATUS)';
    assert.ok(isSuccess || isNotFound, `unexpected response status: ${call}`);
  }
  // Exactly one success status; every other response is the shared 404.
  assert.equal(statuses.filter((s) => s === 'res.status(200)').length, 1);
  // The route never writes a bespoke error body: all failures go through the
  // frozen constant, so the responses are byte-identical.
  const jsonBodies = routeSource.match(/\.json\(\{[^}]*\}\)/g) || [];
  assert.deepEqual(jsonBodies, [], 'no inline error bodies are permitted');
  assert.match(routeSource, /\.json\(LOOKUP_NOT_FOUND_BODY\)/);
});

test('the shared 404 is the frozen, single failure shape', () => {
  assert.equal(LOOKUP_NOT_FOUND_STATUS, 404);
  assert.deepEqual(LOOKUP_NOT_FOUND_BODY, { type: 'not_found' });
  assert.ok(Object.isFrozen(LOOKUP_NOT_FOUND_BODY));
  // It carries no field that could distinguish "no such order" from "wrong email".
  assert.deepEqual(Object.keys(LOOKUP_NOT_FOUND_BODY), ['type']);
});
