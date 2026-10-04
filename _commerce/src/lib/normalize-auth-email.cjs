'use strict';

// Normalize the email address on customer auth entry points BEFORE it reaches
// Medusa's emailpass provider or any lookup. Medusa's `emailpass.register()`
// stores `entity_id` exactly as it appears in the body (no trim, no lowercase),
// which would let "Buyer@Example.com " and "buyer@example.com" become two
// distinct identities. Normalizing here makes register / login / verification /
// lookup / claim all agree on one canonical address.
//
// The middleware mutates the already-parsed JSON body:
//   - `body.email`      (register / login)
//   - `body.entity_id`  (verification request)
// A missing or non-string value is left untouched (downstream validation still
// rejects it with its own message, so this never masks a malformed request).

function normalizeEmail(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
}

function normalizeAuthEmail(req, _res, next) {
  const body = req.body;
  if (body && typeof body === 'object') {
    if ('email' in body) body.email = normalizeEmail(body.email);
    if ('entity_id' in body) body.entity_id = normalizeEmail(body.entity_id);
  }
  return next();
}

module.exports = { normalizeAuthEmail };
