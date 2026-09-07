import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyProduction } from '../scripts/production-probe.mjs';

const httpsOrigin = 'https://shop.example.com';
const httpOrigin = 'http://shop.example.com';

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
