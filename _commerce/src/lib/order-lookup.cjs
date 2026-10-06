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
  'fulfillments.created_at',
  'fulfillments.packed_at',
  'fulfillments.shipped_at',
  'fulfillments.delivered_at',
  'fulfillments.canceled_at',
  'fulfillments.labels.tracking_number',
  'fulfillments.labels.tracking_url',
];

const asIso = (value) => (value ? String(value) : null);

// Serialize a raw `getOrderDetailWorkflow` result into the exact wire shape
// both order endpoints return — the unauthenticated guest lookup
// (`order_number` + `email`) and the authenticated account order detail
// (`Bearer` JWT + order id). Keeping a single serializer guarantees the two
// paths cannot drift apart: the account view is the same shape the guest
// lookup already proved, just gated by customer identity instead of the
// email/order-number pair.
//
// The input `detail` is the workflow's `OrderDetailDTO` as typed in the route.
// Every field is a real Medusa column or an aggregation the workflow already
// computed (`payment_status` / `fulfillment_status`); nothing here invents
// data. `fulfillments` is narrowed through `mapFulfillments` so `label_url`
// and the internal `fulfillment.id` never reach the wire.
function serializeOrderDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const order = detail;
  const shippingAddress = order.shipping_address ?? null;
  const shippingMethod = (order.shipping_methods || [])[0] ?? null;

  return {
    order: {
      order_number: Number.isFinite(Number(order.display_id)) ? Number(order.display_id) : null,
      public_order_number: buildPublicOrderNumber(order.display_id, order.created_at),
      status: typeof order.status === 'string' ? order.status : '',
      payment_status: order.payment_status ?? null,
      fulfillment_status: order.fulfillment_status ?? null,
      currency_code: typeof order.currency_code === 'string' ? order.currency_code : '',
      total: Number(order.total),
      created_at: order.created_at ? String(order.created_at) : '',
      email: typeof order.email === 'string' ? order.email : '',
      items: (Array.isArray(order.items) ? order.items : []).map((item) => ({
        title: item.title ?? '',
        // Defensive fallback: `quantity` is required on the wire. A missing/NaN
        // quantity serializes `1` rather than `undefined` so the storefront
        // never renders "undefined × …".
        quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 1,
        unit_price: Number(item.unit_price),
        total: Number(item.total),
        thumbnail: item.thumbnail ?? null,
      })),
      shipping_method: shippingMethod?.name ?? null,
      shipping_amount: shippingMethod?.amount != null ? Number(shippingMethod.amount) : null,
      shipping_address: shippingAddress
        ? {
            first_name: shippingAddress.first_name ?? null,
            last_name: shippingAddress.last_name ?? null,
            address_1: shippingAddress.address_1 ?? null,
            address_2: shippingAddress.address_2 ?? null,
            city: shippingAddress.city ?? null,
            province: shippingAddress.province ?? null,
            postal_code: shippingAddress.postal_code ?? null,
            country_code: shippingAddress.country_code ?? null,
          }
        : null,
      fulfillments: mapFulfillments(order.fulfillments),
    },
  };
}

// The `fields` whitelist both order endpoints request from the workflow, so
// `serializeOrderDetail` has everything it emits. Kept here (rather than split
// across the two routes) so the shared serializer and the shared field list
// cannot drift: `labels.label_url` is absent by construction.
const ORDER_DETAIL_FIELDS = [
  'id',
  'display_id',
  'status',
  'currency_code',
  'total',
  'created_at',
  'email',
  'items.title',
  'items.quantity',
  'items.unit_price',
  'items.total',
  'items.thumbnail',
  'shipping_methods.name',
  'shipping_methods.amount',
  'shipping_address.first_name',
  'shipping_address.last_name',
  'shipping_address.address_1',
  'shipping_address.address_2',
  'shipping_address.city',
  'shipping_address.province',
  'shipping_address.postal_code',
  'shipping_address.country_code',
  ...LOOKUP_FULFILLMENT_FIELDS,
];

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

// The second — and only other — failure shape the lookup may produce. It is
// reserved for *system* failures (a backend that errored, a database that did
// not answer, a 500/502/503 upstream), never for "the order does not exist" or
// "the email is wrong". Those are 404, indistinguishable by construction. This
// lets the storefront tell "we could not find that order" apart from "the order
// lookup is temporarily broken", without ever leaking the backend's raw error.
// Like the 404 body it is a single frozen constant carrying only a `type`, so
// no internal error detail can slip through.
const LOOKUP_SERVICE_UNAVAILABLE_STATUS = 503;
const LOOKUP_SERVICE_UNAVAILABLE_BODY = Object.freeze({ type: 'service_unavailable' });

// Map raw fulfillments (as returned by the order-detail workflow) to the exact
// wire shape the storefront consumes.
//
//   - Always an array. An order with no fulfillment yields [] and the client
//     renders no logistics block at all.
//   - Oldest-first, so packages list in the order they were created.
//   - Only the real, buyer-visible columns cross the wire. The internal
//     `fulfillment.id` is deliberately NOT emitted: it is a Medusa primary key
//     the storefront has no use for, and omitting it keeps an internal
//     identifier out of an unauthenticated payload. A fulfillment with no
//     labels still carries `labels: []`; the client shows the timeline without
//     inventing a tracking number.
//   - `label_url` is never read, even if a caller hands it over: it is not a
//     whitelisted output field.
function mapFulfillments(rawFulfillments) {
  if (!Array.isArray(rawFulfillments)) return [];
  return rawFulfillments
    .filter((f) => f && typeof f === 'object')
    .map((fulfillment) => ({
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
  ORDER_DETAIL_FIELDS,
  LOOKUP_NOT_FOUND_STATUS,
  LOOKUP_NOT_FOUND_BODY,
  LOOKUP_SERVICE_UNAVAILABLE_STATUS,
  LOOKUP_SERVICE_UNAVAILABLE_BODY,
  buildPublicOrderNumber,
  parseOrderNumberInput,
  isLookupEmail,
  mapFulfillments,
  serializeOrderDetail,
};
