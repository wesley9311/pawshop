'use strict';

// Structured error mapping for the CloudGull <-> PawShop Connector API V1.1.
//
// The connector contract fixes both the HTTP status and the response body shape:
//
//   { "error": string, "code": string, "retryable"?: boolean }
//
// CloudGull retries ONLY when `retryable` is true (or, absent that flag, on
// 408/429/5xx). So `retryable` is not decoration: getting it wrong either makes
// the client hammer a request that can never succeed, or silently drops a
// request that a retry would have completed. Every code below is classified
// deliberately:
//
//   - Auth failures are terminal. The signature covers the body, the timestamp
//     and the nonce, so a retry with a fresh timestamp/nonce and the same
//     credentials would fail identically.
//   - Contract failures (422) are terminal by the contract itself: "422 等契约
//    错误必须先修正数据" — the client must fix the payload, not resend it.
//   - Upstream failures (503/500) are retryable: the write may simply not have
//     landed yet.
//
// This module has no Medusa dependency so it can be unit-tested on its own and
// required from both the HTTP routes and the CJS test suite.

const CONNECTOR_ERROR_CODES = Object.freeze({
  AUTH_HEADERS_REQUIRED: { status: 401, retryable: false },
  REQUEST_TIMESTAMP_EXPIRED: { status: 401, retryable: false },
  INVALID_SERVICE_CREDENTIAL: { status: 401, retryable: false },
  INVALID_REQUEST_SIGNATURE: { status: 401, retryable: false },
  INSUFFICIENT_SCOPE: { status: 403, retryable: false },
  REPLAY_DETECTED: { status: 409, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  METHOD_NOT_ALLOWED: { status: 405, retryable: false },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, retryable: false },
  // Not defined by the contract: the same Idempotency-Key arriving with a
  // different body. CloudGull derives the key from the product revision, so a
  // collision means the caller reused a key for different content. Returning the
  // stored response would silently drop the new content, so this is a hard
  // conflict instead. See docs/PAWSHOP_CONNECTOR_V1.md.
  IDEMPOTENCY_KEY_CONFLICT: { status: 409, retryable: false },
  CONTRACT_VALIDATION_FAILED: { status: 422, retryable: false },
  CONNECTOR_NOT_CONFIGURED: { status: 503, retryable: false },
  TEMPORARY_UPSTREAM_FAILURE: { status: 503, retryable: true },
  INTERNAL_ERROR: { status: 500, retryable: true },
});

class ConnectorRequestError extends Error {
  constructor(code, message, options = {}) {
    const known = CONNECTOR_ERROR_CODES[code];
    if (!known) throw new Error(`Unknown connector error code: ${code}`);
    super(message);
    this.name = 'ConnectorRequestError';
    this.code = code;
    this.status = options.status ?? known.status;
    this.retryable = options.retryable ?? known.retryable;
    this.details = options.details;
  }
}

// The wire body. `retryable` is always emitted explicitly so the client never
// has to fall back to inferring it from the status code.
function connectorErrorBody(error) {
  const body = {
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof ConnectorRequestError ? error.code : 'INTERNAL_ERROR',
    retryable: error instanceof ConnectorRequestError ? error.retryable : true,
  };
  if (error instanceof ConnectorRequestError && error.details !== undefined) {
    body.details = error.details;
  }
  return body;
}

function connectorErrorStatus(error) {
  return error instanceof ConnectorRequestError ? error.status : 500;
}

module.exports = {
  CONNECTOR_ERROR_CODES,
  ConnectorRequestError,
  connectorErrorBody,
  connectorErrorStatus,
};
