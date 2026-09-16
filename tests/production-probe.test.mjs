import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyProduction, hstsMaxAge, wwwOrigin } from '../scripts/production-probe.mjs';

const httpsOrigin = 'https://shop.example.com';
const httpOrigin = 'http://shop.example.com';
const wwwUrl = `${wwwOrigin(httpsOrigin)}/`;
const secureHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

function fixture(overrides = {}) {
  const responses = new Map([
    [`${httpOrigin}/`, { status: 301, headers: { location: `${httpsOrigin}/` }, body: '' }],
    [`${httpsOrigin}/`, { status: 200, headers: { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' }, body: '' }],
    [`${httpsOrigin}/catalog.json`, { status: 200, headers: {}, body: JSON.stringify([{ id: 1, active: true, availability: 'prelaunch', images: ['assets/products/cat-lounger/01-hero-1x1.jpg'] }]) }],
    [`${httpsOrigin}/assets/products/cat-lounger/01-hero-1x1.jpg`, { status: 200, headers: {}, body: '' }],
    [`${httpsOrigin}/admin.html`, { status: 404, headers: {}, body: '' }],
    [`${httpsOrigin}/dashboard.html`, { status: 404, headers: {}, body: '' }],
    [`${httpsOrigin}/account.html`, { status: 404, headers: {}, body: '' }],
  ]);
  for (const [url, result] of Object.entries(overrides)) responses.set(url, result);
  return async url => {
    const result = responses.get(url);
    if (!result) throw new Error(`Unexpected fixture URL: ${url}`);
    return result;
  };
}

test('accepts the closed-commerce production boundary', async () => {
  assert.deepEqual(await verifyProduction({ httpsOrigin, httpOrigin, request: fixture() }), { productCount: 1 });
});

test('rejects a public sensitive route', async () => {
  await assert.rejects(
    verifyProduction({
      httpsOrigin,
      httpOrigin,
      request: fixture({ [`${httpsOrigin}/admin.html`]: { status: 200, headers: {}, body: 'private' } }),
    }),
    /Sensitive route \/admin\.html returned 200/,
  );
});

test('rejects redirect drift and missing security headers', async () => {
  await assert.rejects(
    verifyProduction({
      httpsOrigin,
      httpOrigin,
      request: fixture({ [`${httpOrigin}/`]: { status: 302, headers: { location: `${httpsOrigin}/` }, body: '' } }),
    }),
    /expected 301 or 308/,
  );
  await assert.rejects(
    verifyProduction({
      httpsOrigin,
      httpOrigin,
      request: fixture({ [`${httpsOrigin}/`]: { status: 200, headers: {}, body: '' } }),
    }),
    /X-Content-Type-Options/,
  );
});

test('rejects malformed, empty, or inactive public catalogs', async () => {
  for (const body of [
    'not-json',
    '[]',
    JSON.stringify([{ id: 1, active: false, availability: 'prelaunch', images: ['assets/products/cat-lounger/01-hero-1x1.jpg'] }]),
    JSON.stringify([{ id: 1, active: true, availability: 'in_stock', stock: 100, images: ['https://images.example/hero.jpg'] }]),
  ]) {
    await assert.rejects(verifyProduction({
      httpsOrigin,
      httpOrigin,
      request: fixture({ [`${httpsOrigin}/catalog.json`]: { status: 200, headers: {}, body } }),
    }));
  }
});

test('rejects credentials, paths, and mismatched hosts in production origins', async () => {
  for (const candidate of [
    'https://user:pass@shop.example.com',
    'https://shop.example.com/path',
    'http://shop.example.com',
  ]) {
    await assert.rejects(verifyProduction({ httpsOrigin: candidate, httpOrigin, request: fixture() }), /HTTPS origin/);
  }
  await assert.rejects(
    verifyProduction({ httpsOrigin, httpOrigin: 'http://other.example.com', request: fixture() }),
    /same hostname/,
  );
});

test('hstsMaxAge parses only usable max-age directives', () => {
  assert.equal(hstsMaxAge({}), null);
  assert.equal(hstsMaxAge({ 'strict-transport-security': 'includeSubDomains' }), null);
  assert.equal(hstsMaxAge({ 'strict-transport-security': 'max-age=31536000; includeSubDomains' }), 31536000);
  assert.equal(hstsMaxAge({ 'strict-transport-security': 'max-age="600"' }), 600);
  assert.equal(wwwOrigin('https://shop.example.com'), 'https://www.shop.example.com');
});

test('strict mode accepts a hardened host', async () => {
  const result = await verifyProduction({
    httpsOrigin,
    httpOrigin,
    strict: true,
    request: fixture({
      [`${httpsOrigin}/`]: { status: 200, headers: secureHeaders, body: '' },
      [wwwUrl]: { status: 301, headers: { location: `${httpsOrigin}/` }, body: '' },
    }),
  });
  assert.deepEqual(result, { productCount: 1, hstsMaxAge: 31536000, wwwRedirects: true });
});

test('strict mode rejects a missing or weak HSTS header', async () => {
  await assert.rejects(
    verifyProduction({ httpsOrigin, httpOrigin, strict: true, request: fixture() }),
    /missing a Strict-Transport-Security max-age/,
  );
  await assert.rejects(
    verifyProduction({
      httpsOrigin,
      httpOrigin,
      strict: true,
      request: fixture({
        [`${httpsOrigin}/`]: { status: 200, headers: { ...secureHeaders, 'strict-transport-security': 'max-age=600' }, body: '' },
      }),
    }),
    /below the required 15552000/,
  );
});

test('strict mode rejects a www host that serves content instead of redirecting', async () => {
  const hardened = {
    [`${httpsOrigin}/`]: { status: 200, headers: secureHeaders, body: '' },
  };
  await assert.rejects(
    verifyProduction({
      httpsOrigin,
      httpOrigin,
      strict: true,
      request: fixture({ ...hardened, [wwwUrl]: { status: 200, headers: {}, body: 'duplicate' } }),
    }),
    /www host returned 200; expected 301 or 308/,
  );
  await assert.rejects(
    verifyProduction({
      httpsOrigin,
      httpOrigin,
      strict: true,
      request: fixture({ ...hardened, [wwwUrl]: { status: 301, headers: { location: 'https://other.example.com/' }, body: '' } }),
    }),
    /did not redirect to the exact HTTPS apex origin/,
  );
});

// The strict gates are opt-in: the deployment gate must keep working on a host
// where they are not yet configured, and must never even probe the www host.
test('strict gates stay opt-in for the default probe', async () => {
  assert.deepEqual(await verifyProduction({ httpsOrigin, httpOrigin, request: fixture() }), { productCount: 1 });
});
