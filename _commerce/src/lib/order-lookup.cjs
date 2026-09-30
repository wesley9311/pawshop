'use strict';

// Pure helpers for the guest order lookup.
//
// These were lifted out of the route handler so the two things a buyer can get
// wrong — how they type their order number, and what the server is allowed to
// hand back about fulfilment — are unit-testable without booting Medusa. The
// route keeps only the I/O: query the order, then serialize through here.
//
// Nothing in this file invents data. Every fulfilment field it emits is a real
// Medusa `fulfillment` / `fulfillment_label` column; the client derives state
// from the timestamps and shows nothing it was not given.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public order number format: PS-YYYYMMDD-NNNN, where YYYYMMDD is the order's
// creation date and NNNN is the real Medusa display_id zero-padded to 4 digits.
// It is always derived from real order data on the server — never assembled by
// the client — and is stable for any historical order. It is a cosmetic alias
// for the display_id, not a replacement of the Medusa primary key.
const PUBLIC_PREFIX = 'PS-';
const PUBLIC_PATTERN = /^PS-(\d{8})-(\d+)$/;

function buildPublicOrderNumber(displayId, createdAt) {
  const d = new Date(createdAt);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${PUBLIC_PREFIX}${yyyy}${mm}${dd}-${String(displayId).padStart(4, '0')}`;
}

// Accept every human-typed form of an order number and reduce it to the raw
// Medusa display_id used for the query: "6", "#6", "PS-20260929-0006" all
// resolve to 6. Anything that cannot be reduced to a positive integer is
// invalid and returns the same 404 as every other failure.
function parseOrderNumberInput(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Public order number → extract the display_id portion (rightmost segment).
  const pub = trimmed.match(PUBLIC_PATTERN);
  if (pub) {
    const n = Number(pub[2]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  // "#6" → strip a leading "#" and parse the digits.
  const bare = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const n = Number(bare);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isLookupEmail(raw) {
  return typeof raw === 'string' && EMAIL_PATTERN.test(raw.trim().toLowerCase());
}

// The `fields` the route asks `getOrderDetailWorkflow` for, in the exact order
// they are requested. Kept here so a test can assert the whitelist without
// re-parsing the route, and so `label_url` can be proven absent by construction.
//
// `labels.label_url` is deliberately NOT in this list: it is the shipping-label
// artifact the warehouse prints, not something a buyer is entitled to see
// through a public, unauthenticated lookup. Nothing about the tracking number
// requires it, so it never leaves the server.
const LOOKUP_FULFILLMENT_FIELDS = [
  'fulfillments.id',
  'fulfillments.created_at',
  'fulfillments.packed_at',
  'fulfillments.shipped_at',
  'fulfillments.delivered_at',
  'fulfillments.canceled_at',
  'fulfillments.labels.tracking_number',
  'fulfillments.labels.tracking_url',
];

const asIso = (value) => (value ? String(value) : null);

// The one and only failure response this route is allowed to produce.
//
// Anti-enumeration is a structural property, not a habit: a caller must not be
// able to tell "this order number does not exist" from "the email is wrong"
// from "the query was malformed". Every failure path — including the closed
// storefront — returns exactly this. Because it is a single frozen constant,
// a future edit cannot accidentally introduce a distinguishable error body
// without deleting this line, which the contract test guards.
const LOOKUP_NOT_FOUND_STATUS = 404;
const LOOKUP_NOT_FOUND_BODY = Object.freeze({ type: 'not_found' });

// Map raw fulfillments (as returned by the order-detail workflow) to the exact
// wire shape the storefront consumes.
//
//   - Always an array. An order with no fulfillment yields [] and the client
//     renders no logistics block at all.
//   - Oldest-first, so packages list in the order they were created.
//   - Only the real columns cross the wire. A fulfillment with no labels still
//     carries `labels: []`; the client shows the timeline without inventing a
//     tracking number.
//   - `label_url` is never read, even if a caller hands it over: it is not a
//     whitelisted output field.
function mapFulfillments(rawFulfillments) {
  if (!Array.isArray(rawFulfillments)) return [];
  return rawFulfillments
    .filter((f) => f && typeof f === 'object')
    .map((fulfillment) => ({
      id: String(fulfillment.id),
      created_at: asIso(fulfillment.created_at),
      packed_at: asIso(fulfillment.packed_at),
      shipped_at: asIso(fulfillment.shipped_at),
      delivered_at: asIso(fulfillment.delivered_at),
      canceled_at: asIso(fulfillment.canceled_at),
      labels: (Array.isArray(fulfillment.labels) ? fulfillment.labels : [])
        .filter((label) => label && typeof label === 'object')
        .map((label) => ({
          tracking_number: label.tracking_number ? String(label.tracking_number) : null,
          tracking_url: label.tracking_url ? String(label.tracking_url) : null,
        })),
    }))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

module.exports = {
  EMAIL_PATTERN,
  PUBLIC_PREFIX,
  PUBLIC_PATTERN,
  LOOKUP_FULFILLMENT_FIELDS,
  LOOKUP_NOT_FOUND_STATUS,
  LOOKUP_NOT_FOUND_BODY,
  buildPublicOrderNumber,
  parseOrderNumberInput,
  isLookupEmail,
  mapFulfillments,
};
