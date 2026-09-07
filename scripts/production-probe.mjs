import http from 'node:http';
import https from 'node:https';

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 1_048_576;

function normalizedOrigin(value, protocol, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute ${protocol} origin.`);
  }
  if (
    url.protocol !== `${protocol}:` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(`${label} must be an absolute ${protocol} origin.`);
  }
  return url.origin;
}

export function requestOnce(url, { timeoutMs = DEFAULT_TIMEOUT_MS, readBody = false } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error('Probe timeout must be an integer from 100 to 30000 milliseconds.');
  }
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(parsed, { method: 'GET', timeout: timeoutMs }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        if (!readBody) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          request.destroy(new Error('Probe response exceeded the one-megabyte limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: readBody ? Buffer.concat(chunks).toString('utf8') : '',
      }));
      if (!readBody) response.resume();
    });
    request.on('timeout', () => request.destroy(new Error(`Probe exceeded ${timeoutMs}ms.`)));
    request.on('error', reject);
    request.end();
  });
}

function expectStatus(result, expected, label) {
  if (result.status !== expected) throw new Error(`${label} returned ${result.status}; expected ${expected}.`);
}

export async function verifyProduction({ httpsOrigin, httpOrigin, request = requestOnce }) {
  const secure = normalizedOrigin(httpsOrigin, 'https', 'HTTPS origin');
  const insecure = normalizedOrigin(httpOrigin, 'http', 'HTTP origin');
  if (new URL(secure).hostname !== new URL(insecure).hostname) {
    throw new Error('HTTP and HTTPS origins must use the same hostname.');
  }

  const redirect = await request(`${insecure}/`);
  if (![301, 308].includes(redirect.status)) throw new Error(`HTTP root returned ${redirect.status}; expected 301 or 308.`);
  if (redirect.headers.location !== `${secure}/`) throw new Error('HTTP root did not redirect to the exact HTTPS origin.');

  const home = await request(`${secure}/`);
  expectStatus(home, 200, 'HTTPS root');
  if (String(home.headers['x-content-type-options']).toLowerCase() !== 'nosniff') {
    throw new Error('HTTPS root is missing X-Content-Type-Options: nosniff.');
  }
  if (String(home.headers['x-frame-options']).toUpperCase() !== 'DENY') {
    throw new Error('HTTPS root is missing X-Frame-Options: DENY.');
  }

  const catalog = await request(`${secure}/catalog.json`, { readBody: true });
  expectStatus(catalog, 200, 'Public catalog');
  let products;
  try {
    products = JSON.parse(catalog.body);
  } catch {
    throw new Error('Public catalog is not valid JSON.');
  }
  if (!Array.isArray(products) || products.length < 1 || products.some(product => product?.active !== true)) {
    throw new Error('Public catalog must contain at least one active product and no inactive products.');
  }

  for (const path of ['admin.html', 'dashboard.html', 'account.html']) {
    const result = await request(`${secure}/${path}`);
    expectStatus(result, 404, `Sensitive route /${path}`);
  }

  return { productCount: products.length };
}

