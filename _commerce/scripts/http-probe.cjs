'use strict';

// A refusal response is a small structured error. Reading it is bounded so a
// misbehaving endpoint cannot make a boundary probe accumulate a large body.
const MAX_REFUSAL_BYTES = 1024;

async function closeResponseBody(response) {
  try {
    if (response.body) await response.body.cancel();
  } catch {
    throw new Error('HTTP probe failed: could not close the response body.');
  }
}

async function readBoundedBody(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new Error('HTTP probe failed: refusal body exceeded the reviewed bound.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream already ended or failed; there is nothing left to release.
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Never follow redirects with local credentials or include response bodies in errors.
// Pass `type` to require a structured refusal type in addition to the status; the
// body itself is still never echoed into an error message.
async function expectHttpStatus(url, { method = 'GET', status, type, headers = {}, timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new Error('Probe timeout must be between 1 and 30000 milliseconds.');
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: method === 'POST' ? '{}' : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(`HTTP probe failed: ${method}; connection failed or exceeded ${timeoutMs}ms.`);
  }
  if (response.status !== status) {
    await closeResponseBody(response);
    throw new Error(`HTTP probe failed: ${method} returned ${response.status}; expected ${status}.`);
  }
  if (type === undefined) {
    // Status-only probe: do not accumulate an unbounded response body.
    await closeResponseBody(response);
    return;
  }
  const body = await readBoundedBody(response, MAX_REFUSAL_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`HTTP probe failed: ${method} returned an unreadable refusal body.`);
  }
  const observed = typeof parsed?.type === 'string' ? parsed.type : 'none';
  if (observed !== type) {
    throw new Error(`HTTP probe failed: ${method} returned refusal type ${observed}; expected ${type}.`);
  }
}

module.exports = { MAX_REFUSAL_BYTES, expectHttpStatus };
