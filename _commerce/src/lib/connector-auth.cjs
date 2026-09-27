'use strict';

// PawShop-side implementation of the CloudGull Connector V1.1 request security
// contract. The reference implementation is CloudGull's
// `lib/connectors/pawshop/pawshop-auth.ts`; this file must accept exactly what
// that code signs, and must reject in the same order so the error a caller sees
// does not depend on which side validates first.
//
// Wire contract (see docs/cloudgull/PAWSHOP_CONNECTOR_API_V1.md):
//
//   Authorization: Bearer <service-token>
//   X-CloudGull-Key-Id        non-sensitive key identifier
//   X-CloudGull-Key-Version   rotation version
//   X-CloudGull-Timestamp     unix milliseconds, default +/-5 minutes
//   X-CloudGull-Nonce         fresh per attempt; server rejects replays
//   X-CloudGull-Signature     v1=<HMAC-SHA256 hex>
//   Idempotency-Key           required on every write
//
// Signature preimage: method, full path, sha256(body), timestamp, nonce and the
// Idempotency-Key joined with "\n". The Idempotency-Key is an empty string when
// absent, which is why a GET preimage ends with a trailing newline.
//
// No Medusa dependency: the nonce/credential lookups are injected, so this
// module is unit-testable and can be checked against CloudGull's real signer.

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { ConnectorRequestError } = require('./connector-errors.cjs');

const CONNECTOR_SCOPES = Object.freeze(['connector:health:read', 'connector:products:write']);
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;

// Public path prefix CloudGull signs against, and the prefix this service
// actually mounts the routes on. nginx rewrites `/api/connector/v1/` to
// `/connector/v1/` and forwards the request unchanged, so the canonical path has
// to be rebuilt from the mounted URL. Both constants are asserted by tests.
const CONNECTOR_PUBLIC_PREFIX = '/api/connector/v1';
const CONNECTOR_MOUNT_PREFIX = '/connector/v1';

const SUFFIX_CURRENT = '';
const SUFFIX_NEXT = '_NEXT';

function publicPathFromMountedUrl(originalUrl) {
  const url = String(originalUrl || '');
  if (!url.startsWith(CONNECTOR_MOUNT_PREFIX)) {
    throw new Error(`Connector request URL ${url} is outside ${CONNECTOR_MOUNT_PREFIX}.`);
  }
  return `${CONNECTOR_PUBLIC_PREFIX}${url.slice(CONNECTOR_MOUNT_PREFIX.length)}`;
}

function bodySha256(body) {
  return createHash('sha256').update(String(body ?? ''), 'utf8').digest('hex');
}

function canonicalRequest({ method, path, body, timestamp, nonce, idempotencyKey }) {
  return [
    String(method).toUpperCase(),
    path,
    bodySha256(body ?? ''),
    String(timestamp),
    String(nonce),
    idempotencyKey || '',
  ].join('\n');
}

function signatureFor(signingSecret, canonical) {
  return `v1=${createHmac('sha256', signingSecret).update(canonical).digest('hex')}`;
}

// Constant-time string compare that does not leak length through an early
// return: length is compared first (harmless, it is not secret) and equal-length
// inputs go through crypto.timingSafeEqual.
function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseScopes(rawScopes) {
  const scopes = String(rawScopes || '')
    .split(/[\s,]+/)
    .filter(Boolean);
  const invalid = scopes.filter((scope) => !CONNECTOR_SCOPES.includes(scope));
  if (invalid.length) throw new Error(`Unknown PawShop Connector scope: ${invalid.join(', ')}`);
  return scopes;
}

function parseEpoch(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`PawShop Connector credential date is invalid: ${value}`);
  return parsed;
}

function readCredential(environment, suffix = SUFFIX_CURRENT) {
  const keyId = environment[`PAWSHOP_CONNECTOR_KEY_ID${suffix}`];
  const token = environment[`PAWSHOP_CONNECTOR_SERVICE_TOKEN${suffix}`];
  const signingSecret = environment[`PAWSHOP_CONNECTOR_SIGNING_SECRET${suffix}`];
  if (!keyId && !token && !signingSecret) return null;
  if (!keyId || !token || !signingSecret) {
    throw new Error(`PawShop Connector credential${suffix || ' (current)'} is incomplete.`);
  }
  const scopes = parseScopes(environment[`PAWSHOP_CONNECTOR_SCOPES${suffix}`]);
  if (scopes.length === 0) {
    throw new Error(`PawShop Connector credential${suffix || ' (current)'} has no scope.`);
  }
  const version = environment[`PAWSHOP_CONNECTOR_KEY_VERSION${suffix}`] || '1';
  return {
    keyId,
    token,
    signingSecret,
    scopes,
    version,
    notBefore: parseEpoch(environment[`PAWSHOP_CONNECTOR_NOT_BEFORE${suffix}`]),
    expiresAt: parseEpoch(environment[`PAWSHOP_CONNECTOR_EXPIRES_AT${suffix}`]),
  };
}

// Credentials are read straight from the process environment. In production they
// arrive through /etc/pawshop/connector.env (0600 root:root) as a second
// systemd EnvironmentFile, deliberately outside the closed 20-key commerce.env
// contract. A configuration error is loud on purpose: a partially configured
// credential would otherwise silently widen access.
function readConnectorCredentials(environment = process.env) {
  const credentials = [
    readCredential(environment, SUFFIX_CURRENT),
    readCredential(environment, SUFFIX_NEXT),
  ].filter((credential) => credential !== null);
  if (credentials.length === 0) {
    throw new Error('PawShop Connector credentials are not configured.');
  }
  return credentials;
}

function isActive(credential, now) {
  if (credential.notBefore !== undefined && credential.notBefore > now) return false;
  if (credential.expiresAt !== undefined && credential.expiresAt <= now) return false;
  return true;
}

// A credential is identified by the (keyId, keyVersion) pair, exactly as
// CloudGull selects it, so a rotated key can never be confused with its
// predecessor that happens to share a key id.
function findVerificationCredential(credentials, keyId, keyVersion, now) {
  return credentials.find(
    (credential) => credential.keyId === keyId && credential.version === keyVersion && isActive(credential, now)
  );
}

function headerValue(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// Mirrors CloudGull's verifyPawShopRequest step for step, in the same order.
// Each step throws the same code the reference implementation throws.
async function verifyConnectorRequest(input) {
  const {
    headers,
    method,
    publicPath,
    rawBody,
    requiredScope,
    credentials,
    claimNonce,
    now = Date.now(),
    maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS,
  } = input;

  const keyId = headerValue(headers, 'x-cloudgull-key-id');
  const keyVersion = headerValue(headers, 'x-cloudgull-key-version');
  const timestamp = headerValue(headers, 'x-cloudgull-timestamp');
  const nonce = headerValue(headers, 'x-cloudgull-nonce');
  const suppliedSignature = headerValue(headers, 'x-cloudgull-signature');
  const authorization = headerValue(headers, 'authorization');
  const idempotencyKey = headerValue(headers, 'idempotency-key');

  if (!keyId || !keyVersion || !timestamp || !nonce || !suppliedSignature ||
      typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new ConnectorRequestError('AUTH_HEADERS_REQUIRED', 'Authentication headers are incomplete.');
  }

  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > maxClockSkewMs) {
    throw new ConnectorRequestError('REQUEST_TIMESTAMP_EXPIRED', 'The request timestamp is outside the allowed window.');
  }

  const credential = findVerificationCredential(credentials, keyId, keyVersion, now);
  if (!credential || !safeEqual(authorization.slice('Bearer '.length), credential.token)) {
    throw new ConnectorRequestError('INVALID_SERVICE_CREDENTIAL', 'The service credential is not valid.');
  }

  if (!credential.scopes.includes(requiredScope)) {
    throw new ConnectorRequestError('INSUFFICIENT_SCOPE', `The service credential lacks scope ${requiredScope}.`);
  }

  const canonical = canonicalRequest({
    method,
    path: publicPath,
    body: rawBody,
    timestamp,
    nonce,
    idempotencyKey,
  });
  const expectedSignature = signatureFor(credential.signingSecret, canonical);
  if (!safeEqual(suppliedSignature, expectedSignature)) {
    throw new ConnectorRequestError('INVALID_REQUEST_SIGNATURE', 'The request signature is not valid.');
  }

  // Replay is checked last, after the signature is proven, so an unauthenticated
  // caller cannot burn a legitimate nonce. The window is the clock-skew window:
  // outside it the timestamp check already rejects the request.
  const claimed = await claimNonce({ keyId, nonce, expiresAt: now + DEFAULT_REPLAY_WINDOW_MS });
  if (!claimed) {
    throw new ConnectorRequestError('REPLAY_DETECTED', 'This nonce has already been used.');
  }

  return { keyId: credential.keyId, keyVersion: credential.version, scopes: [...credential.scopes] };
}

module.exports = {
  CONNECTOR_MOUNT_PREFIX,
  CONNECTOR_PUBLIC_PREFIX,
  CONNECTOR_SCOPES,
  DEFAULT_MAX_CLOCK_SKEW_MS,
  DEFAULT_REPLAY_WINDOW_MS,
  bodySha256,
  canonicalRequest,
  findVerificationCredential,
  publicPathFromMountedUrl,
  readConnectorCredentials,
  safeEqual,
  signatureFor,
  verifyConnectorRequest,
};
