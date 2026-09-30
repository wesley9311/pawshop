'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  US_STATE_CODES,
  validateAddressStructure,
  validateCartShippingAddress,
} = require('../src/lib/address-structure.cjs');

// ---------- helpers ----------

// A minimal, structurally complete US address; individual tests override one
// field at a time so each assertion isolates a single rule.
function usAddress(overrides = {}) {
  return {
    first_name: 'Ada',
    last_name: 'Lovelace',
    address_1: '1 Main St',
    city: 'New York',
    province: 'NY',
    postal_code: '10001',
    country_code: 'us',
    ...overrides,
  };
}

function fieldsOf(errors) {
  return errors.map((e) => e.field).sort();
}

// A fake Express req/res pair. `res.status().json()` records the response and
// `next` records whether the request was allowed through.
function runMiddleware(body) {
  const req = { body };
  const res = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  let nextCalled = false;
  validateCartShippingAddress(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

// ---------- required-field completeness ----------

test('a complete US address passes every rule', () => {
  assert.deepEqual(validateAddressStructure(usAddress()), []);
  assert.deepEqual(validateAddressStructure(usAddress({ province: 'NY', postal_code: '10001' })), []);
});

test('every required address field is enforced when missing', () => {
  const cases = [
    ['first_name', 'First name is required.'],
    ['last_name', 'Last name is required.'],
    ['address_1', 'Address line 1 is required.'],
    ['city', 'City is required.'],
    ['country_code', 'Country is required.'],
    ['province', 'State / province is required.'],
    ['postal_code', 'Postal code is required.'],
  ];
  for (const [field, message] of cases) {
    const errors = validateAddressStructure(usAddress({ [field]: '' }));
    const match = errors.find((e) => e.field === field);
    assert.ok(match, `${field} is required`);
    assert.equal(match.code, 'required');
    assert.equal(match.message, message);
  }
});

test('whitespace-only values count as missing, not as present', () => {
  const errors = validateAddressStructure(usAddress({ city: '   ' }));
  assert.deepEqual(fieldsOf(errors), ['city']);
});

test('a non-object address reports every required field rather than throwing', () => {
  for (const value of [null, undefined, 'addr_1', 42]) {
    const errors = validateAddressStructure(value);
    assert.equal(errors.length, 7);
    assert.ok(errors.every((e) => e.code === 'required'));
  }
});

// ---------- US state rule ----------

test('US state must be a real state / DC / territory code', () => {
  assert.deepEqual(validateAddressStructure(usAddress({ province: 'CA' })), []);
  assert.deepEqual(validateAddressStructure(usAddress({ province: 'DC' })), []);
  // Territories the storefront offers are structurally valid too.
  for (const territory of ['AS', 'GU', 'MP', 'PR', 'VI']) {
    assert.deepEqual(validateAddressStructure(usAddress({ province: territory })), [], `${territory} is accepted`);
  }
  // Lowercase input is accepted — the code is compared case-insensitively.
  assert.deepEqual(validateAddressStructure(usAddress({ province: 'ny' })), []);
});

test('an invalid US state is rejected with a province field error', () => {
  const errors = validateAddressStructure(usAddress({ province: 'ZZ' }));
  assert.deepEqual(fieldsOf(errors), ['province']);
  assert.equal(errors[0].code, 'invalid_state');
});

test('the accepted state set is exactly the 50 states + DC + 5 territories', () => {
  assert.equal(US_STATE_CODES.size, 56);
  for (const bogus of ['ZZ', 'XX', 'UK', 'EN', 'ON']) {
    assert.ok(!US_STATE_CODES.has(bogus), `${bogus} is not a US subdivision`);
  }
});

// ---------- US ZIP rule ----------

test('a valid US ZIP (5 digits or ZIP+4) passes', () => {
  assert.deepEqual(validateAddressStructure(usAddress({ postal_code: '10001' })), []);
  assert.deepEqual(validateAddressStructure(usAddress({ postal_code: '10001-1234' })), []);
});

test('a malformed US ZIP is rejected', () => {
  for (const bad of ['1234', '123456', '12345-12', '10001-12345', 'ABCDE', '10001 1234', ' 10001!']) {
    const errors = validateAddressStructure(usAddress({ postal_code: bad }));
    assert.deepEqual(fieldsOf(errors), ['postal_code'], `${bad} is rejected`);
    assert.equal(errors[0].code, 'invalid_postal_code');
  }
});

test('a US address can report a bad state and a bad ZIP at the same time', () => {
  const errors = validateAddressStructure(usAddress({ province: 'ZZ', postal_code: '1234' }));
  assert.deepEqual(fieldsOf(errors), ['postal_code', 'province']);
});

// ---------- non-US addresses ----------

test('a non-US address gets only the required-field check, never the US shape', () => {
  // A Canadian address with a perfectly normal Canadian postal code must not be
  // judged by the US ZIP rule.
  const canada = {
    first_name: 'Ada', last_name: 'Lovelace', address_1: '1 King St',
    city: 'Toronto', province: 'ON', postal_code: 'M5V 2T6', country_code: 'ca',
  };
  assert.deepEqual(validateAddressStructure(canada), []);
});

test('a non-US address still has to be complete', () => {
  const errors = validateAddressStructure({ country_code: 'ca', city: 'Toronto' });
  assert.deepEqual(fieldsOf(errors), ['address_1', 'first_name', 'last_name', 'postal_code', 'province']);
});

test('country_code is matched case-insensitively for choosing the rule set', () => {
  // 'US' (uppercase, as the storefront sends it) still triggers the US rules.
  const errors = validateAddressStructure(usAddress({ country_code: 'US', postal_code: '1234' }));
  assert.deepEqual(fieldsOf(errors), ['postal_code']);
});

// ---------- middleware: the gate that runs before payment ----------

test('the middleware lets a valid cart address through untouched', () => {
  const { res, nextCalled } = runMiddleware({ shipping_address: usAddress() });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null, 'no response written for a valid address');
});

test('the middleware rejects a US address with a bad state before anything else runs', () => {
  const { res, nextCalled } = runMiddleware({ shipping_address: usAddress({ province: 'ZZ' }) });
  assert.equal(nextCalled, false, 'request is stopped');
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.type, 'invalid_data');
  assert.equal(res.payload.code, 'cart_shipping_address_invalid');
  assert.equal(res.payload.errors.length, 1);
  assert.equal(res.payload.errors[0].field, 'province');
});

test('the middleware rejects a US address with a bad ZIP', () => {
  const { res, nextCalled } = runMiddleware({ shipping_address: usAddress({ postal_code: '1234' }) });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.errors[0].field, 'postal_code');
});

test('the middleware rejects an incomplete address', () => {
  const { res, nextCalled } = runMiddleware({ shipping_address: { country_code: 'us', city: 'New York' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.ok(res.payload.errors.some((e) => e.field === 'address_1'));
  assert.ok(res.payload.errors.some((e) => e.field === 'city') === false, 'the city that was sent is accepted');
});

test('cart updates that do not carry an address pass straight through', () => {
  // Email-only update.
  assert.equal(runMiddleware({ email: 'buyer@example.com' }).nextCalled, true);
  // No body at all.
  assert.equal(runMiddleware(undefined).nextCalled, true);
  // A string shipping_address references an existing address id: nothing new to
  // structure-check, so the request is not blocked (Medusa's own schema rules).
  assert.equal(runMiddleware({ shipping_address: 'addr_01ABC' }).nextCalled, true);
});

// ---------- wiring: the gate must be mounted on the cart write routes ----------

test('the middleware is mounted on both cart write routes, storefront profile only', () => {
  const middlewares = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api', 'middlewares.ts'),
    'utf8',
  );
  assert.match(middlewares, /validateCartShippingAddress/);
  assert.match(middlewares, /matcher:\s*'\/store\/carts'/);
  assert.match(middlewares, /matcher:\s*'\/store\/carts\/:id'/);
  assert.match(middlewares, /method:\s*'POST'/);
  // Only registered when the storefront profile is open — the closed profile
  // must keep answering 503 for /store.
  assert.match(middlewares, /commerceOpen[\s\S]*validateCartShippingAddress/);
});
