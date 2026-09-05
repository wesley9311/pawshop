'use strict';

// Never follow redirects with local credentials or include response bodies in errors.
async function expectHttpStatus(url, { method = 'GET', status, headers = {}, timeoutMs = 5000 } = {}) {
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
  // Status-only probe: do not accumulate an unbounded response body.
  try {
    if (response.body) await response.body.cancel();
  } catch {
    throw new Error('HTTP probe failed: could not close the response body.');
  }
  if (response.status !== status) {
    throw new Error(`HTTP probe failed: ${method} returned ${response.status}; expected ${status}.`);
  }
}

module.exports = { expectHttpStatus };
