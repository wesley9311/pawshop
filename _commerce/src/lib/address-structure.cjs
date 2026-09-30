'use strict';

// A11 — server-side shipping-address STRUCTURE validation.
//
// Medusa's address schema (`AddressPayload`) marks every field `.nullish()`, so
// the framework requires nothing at all: a cart can carry a US address with no
// city, no state and no ZIP and the store API accepts it. The storefront does
// validate the form, but the browser is not an authority — this module is the
// server-side final line of defence.
//
// Scope, deliberately narrow:
//   * Required-field completeness (every country).
//   * US structural rules: a real state/DC/territory code and a real ZIP /
//     ZIP+4 shape.
//   * Non-US addresses get ONLY the required-field check. We never invent
//     per-country formats for them.
//
// What this module must NOT do: decide where we ship. Which countries are
// deliverable stays Medusa's region / service-zone decision. We only look at
// `country_code` to choose which *structure* rules apply; we never reject a
// country, and we never re-declare the shippable list.

// Two-letter codes for the 50 states, the District of Columbia and the US
// territories the storefront offers. This is a fixed structural list of valid
// US subdivisions — not a shippability rule.
const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
  'AS', 'GU', 'MP', 'PR', 'VI',
]);

// 5 digits, optionally ZIP+4. The 4-digit extension must be exactly four
// digits; nothing else (letters, spaces, a lone 9-digit run) is accepted.
const US_ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fieldError(field, code, message) {
  return { field, code, message };
}

// Returns [] when the address is structurally valid, otherwise one entry per
// problem: { field, code, message }. `field` is the Medusa snake_case address
// key so a caller can map it straight back onto a form input.
function validateAddressStructure(address) {
  const source = address && typeof address === 'object' ? address : {};
  const country = asTrimmedString(source.country_code).toLowerCase();
  const firstName = asTrimmedString(source.first_name);
  const lastName = asTrimmedString(source.last_name);
  const address1 = asTrimmedString(source.address_1);
  const city = asTrimmedString(source.city);
  const province = asTrimmedString(source.province);
  const postal = asTrimmedString(source.postal_code);

  const errors = [];
  const requireField = (value, field, message) => {
    if (!value) errors.push(fieldError(field, 'required', message));
  };

  requireField(firstName, 'first_name', 'First name is required.');
  requireField(lastName, 'last_name', 'Last name is required.');
  requireField(address1, 'address_1', 'Address line 1 is required.');
  requireField(city, 'city', 'City is required.');
  requireField(country, 'country_code', 'Country is required.');
  requireField(province, 'province', 'State / province is required.');
  requireField(postal, 'postal_code', 'Postal code is required.');

  // US-only structural rules. `province`/`postal_code` presence is already
  // handled above, so these only add a *shape* complaint for a value that is
  // present but wrong.
  if (country === 'us') {
    if (province && !US_STATE_CODES.has(province.toUpperCase())) {
      errors.push(fieldError(
        'province',
        'invalid_state',
        'Enter a valid US state code (two letters, e.g. NY, CA, DC).',
      ));
    }
    if (postal && !US_ZIP_PATTERN.test(postal)) {
      errors.push(fieldError(
        'postal_code',
        'invalid_postal_code',
        'Enter a valid US ZIP code (12345 or 12345-6789).',
      ));
    }
  }

  return errors;
}

// Express middleware. Mounted on the cart write routes (POST /store/carts and
// POST /store/carts/:id), which is the only way the storefront stores an
// address — so an invalid address can never be persisted, and payment
// collection / the PayPal hand-off is therefore always downstream of a valid
// address. Updates that do not touch the address (email, shipping method) pass
// straight through.
function validateCartShippingAddress(req, res, next) {
  const body = req && req.body;
  const address = body && body.shipping_address;

  // A string shipping_address references an existing address id (the create
  // route allows it); there is no new structure to inspect. A missing or
  // non-object value is left to Medusa's own schema.
  if (!address || typeof address !== 'object') return next();

  const errors = validateAddressStructure(address);
  if (!errors.length) return next();

  return res.status(400).json({
    type: 'invalid_data',
    code: 'cart_shipping_address_invalid',
    message: 'The shipping address is not valid.',
    errors,
  });
}

module.exports = {
  US_STATE_CODES,
  US_ZIP_PATTERN,
  validateAddressStructure,
  validateCartShippingAddress,
};
