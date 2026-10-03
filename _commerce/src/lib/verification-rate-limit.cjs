'use strict';

// Verification-code rate limiting for the customer email-verification flow.
//
// The stock `POST /auth/verification/request` would let an attacker re-request
// codes without bound (it only caps the code TTL, not the request rate). This
// module defines the limits and the pure "should we allow" decision, so the
// middleware stays thin and the policy is unit-testable.
//
// Limits (per Owner decision):
//   - resend cooldown: 60 seconds between requests for the same email
//   - per email: 5 requests per rolling hour
//   - per IP: 20 requests per rolling hour
//
// Public behaviour must not leak account existence: every limit rejection and
// every malformed request returns the SAME response shape as a successful
// request does not reveal — the request route returns 201 uniformly and the
// delivery subscriber decides whether to actually send. (The route itself must
// not differ in status between "unknown email" and "known email".)

const COOLDOWN_MS = 60 * 1000;                 // 60s resend cooldown
const EMAIL_PER_HOUR = 5;                       // max requests per email per hour
const IP_PER_HOUR = 20;                         // max requests per IP per hour
const WINDOW_MS = 60 * 60 * 1000;               // rolling hour

// A minimal clock/now abstraction so tests can freeze time.
function nowMs(clock) {
  const c = clock && typeof clock.now === 'function' ? clock.now() : Date.now();
  return c;
}

// Decide whether a request is allowed given the request history. `history` is an
// array of epoch-ms timestamps of prior requests for the SAME key (email or IP).
// Returns `{ allowed: boolean, retryAfterMs: number }`.
function evaluate(history, { limit, cooldownMs, windowMs }) {
  const now = nowMs(history._clock);
  const times = (Array.isArray(history) ? history : [])
    .filter((t) => typeof t === 'number' && now - t < windowMs)
    .sort((a, b) => b - a);

  // Cooldown: the most recent request must be at least cooldownMs ago.
  if (times.length && cooldownMs != null) {
    const mostRecent = times[0];
    const sinceLast = now - mostRecent;
    if (sinceLast < cooldownMs) {
      return { allowed: false, retryAfterMs: cooldownMs - sinceLast };
    }
  }

  if (times.length >= limit) {
    // Next allowed when the oldest in-window request ages out.
    const oldest = times[times.length - 1];
    return { allowed: false, retryAfterMs: windowMs - (now - oldest) };
  }

  return { allowed: true, retryAfterMs: 0 };
}

module.exports = {
  COOLDOWN_MS,
  EMAIL_PER_HOUR,
  IP_PER_HOUR,
  WINDOW_MS,
  evaluate,
};
