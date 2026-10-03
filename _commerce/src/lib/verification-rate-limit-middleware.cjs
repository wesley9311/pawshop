'use strict';

// Rate-limit middleware for `POST /auth/verification/request`.
//
// Enforces (per Owner decision):
//   - per email: 60s resend cooldown + max 5/hour
//   - per IP:    20/hour
//
// Anti-enumeration: every rejection returns the SAME 429 body regardless of
// whether the email exists, so an attacker cannot tell "rate-limited because the
// account exists" from "rate-limited because it does not". The response never
// echoes the email or any account state.
//
// The middleware resolves the customer-auth service and delegates the counting to
// `recordVerificationRequest`, which keeps a sliding window in PG.

const { COOLDOWN_MS, EMAIL_PER_HOUR, IP_PER_HOUR } = require('./verification-rate-limit.cjs');
const { normalizeEmail } = require('./customer-claim.cjs');

function clientIp(req) {
  const xff = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  if (req.ip) return req.ip;
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

const TOO_MANY = { type: 'not_allowed', message: 'Too many verification requests. Please try again later.' };

async function verificationRateLimit(req, res, next) {
  try {
    const pawshopCustomerAuth = req.scope.resolve('pawshopCustomerAuth');

    // Per-IP cap (20/hour, no cooldown).
    const ipKey = clientIp(req);
    const ipDecision = await pawshopCustomerAuth.recordVerificationRequest({
      scope: 'ip',
      scopeKey: ipKey,
      limit: IP_PER_HOUR,
      cooldownMs: 0,
      now: new Date(),
    });
    if (!ipDecision.allowed) {
      return res.status(429).json(TOO_MANY);
    }

    // Per-email cap (5/hour + 60s cooldown).
    const body = req.body || {};
    const email = normalizeEmail(typeof body.entity_id === 'string' ? body.entity_id : '');
    if (email) {
      const emailDecision = await pawshopCustomerAuth.recordVerificationRequest({
        scope: 'email',
        scopeKey: email,
        limit: EMAIL_PER_HOUR,
        cooldownMs: COOLDOWN_MS,
        now: new Date(),
      });
      if (!emailDecision.allowed) {
        return res.status(429).json(TOO_MANY);
      }
    }

    return next();
  } catch (error) {
    // A rate-limit store failure must not block the request (fail-open on
    // infrastructure, not on policy). The token provider still caps code TTL.
    return next();
  }
}

module.exports = { verificationRateLimit };
