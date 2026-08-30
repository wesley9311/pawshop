import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const product = { id: 1, name: 'Preview lounger', price: 29.9, stock: 10, active: true };

// Execute the actual inline page scripts with a minimal DOM. Browser layout and
// event interactions are verified separately; these tests cover data boundaries.
function boot(file, saved = []) {
  const nodes = new Map();
  const storage = new Map([['pawshop_cart', JSON.stringify(saved)]]);
  const calls = [];
  let resolveCatalog;
  let rejectCatalog;
  const response = new Promise((resolve, reject) => { resolveCatalog = resolve; rejectCatalog = reject; });
  const context = vm.createContext({
    URL, URLSearchParams, console,
    location: { origin: 'http://localhost:4173', href: `http://localhost:4173/pawshop/${file}?id=1`, search: '?id=1', reload() {} },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    document: {
      title: '', body: { style: {} }, documentElement: {},
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', value: '', style: {}, classList: { add() {}, remove() {}, toggle() {} } });
        return nodes.get(id);
      },
      querySelectorAll: () => [], querySelector: () => null, addEventListener() {},
    },
    addEventListener() {}, setTimeout() {}, clearTimeout() {},
    fetch(url, options) { calls.push({ url, options }); return response; },
  });
  context.window = context;
  vm.runInContext(read('safe.js'), context);
  const source = read(file);
  for (const match of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
  return {
    context, nodes, storage, calls, source,
    run: code => vm.runInContext(code, context),
    async load(data) { resolveCatalog({ ok: true, json: async () => data }); await new Promise(setImmediate); },
    async fail() { rejectCatalog(new Error('offline')); await new Promise(setImmediate); },
  };
}

for (const page of ['PawShop.html', 'product.html']) {
  test(`${page}: no demo catalog on initial load or fetch failure`, async () => {
    const app = boot(page, [{ id: 1, qty: 2 }]);
    assert.equal(app.run('loadProducts().length'), 0);
    assert.equal(app.storage.get('pawshop_cart'), '[{"id":1,"qty":2}]');
    await app.fail();
    assert.equal(app.run('loadProducts().length'), 0);
    assert.equal(app.storage.get('pawshop_cart'), '[{"id":1,"qty":2}]');
  });

  test(`${page}: catalog and saved-list inputs stay inert`, async () => {
    const app = boot(page, [{ id: 1, qty: '<img src=x onerror=alert(1)>' }]);
    await app.load([{ ...product, name: '<img src=x onerror=alert(1)>', icon: 'x" onerror="alert(1)', imageUrl: 'https://i.ibb.co/x" onerror="alert(1)' }, { ...product, id: 2, active: false }]);
    assert.equal(app.run('cart.length'), 1);
    assert.equal(app.run('cart[0].qty'), 1);
    assert.equal(app.run('PawSafe.catalog([{id: 2, name: "Hidden", price: 1, stock: 1, active: false}]).length'), 0);
    const markup = app.nodes.get(page === 'PawShop.html' ? 'productGrid' : 'pdp').innerHTML;
    assert.ok(markup.includes('&lt;img'));
    assert.ok(!markup.includes('src="https://i.ibb.co/x" onerror='));
    assert.ok(!app.nodes.get('cartItems').innerHTML.includes('<img src=x onerror='));
    app.run('openWaitlist(); submitWaitlist();');
    assert.equal(app.calls.length, 1, 'only the catalog request is made');
    assert.equal(app.calls[0].options, undefined);
    assert.ok(!/type="(?:email|tel)"|<form\b|placeOrder\(/i.test(app.source));
    assert.ok(![...app.storage.keys()].some(key => /email|order|address|waitlist/i.test(key)));
  });

  test(`${page}: hidden products and empty catalogs do not reappear`, async () => {
    const app = boot(page);
    await app.load([{ ...product, active: false }]);
    assert.equal(app.run(page === 'PawShop.html' ? 'products.length' : 'loadProducts().length'), 0);
    if (page === 'product.html') assert.equal(app.run('currentProduct'), null);
    const empty = boot(page);
    await empty.load([]);
    assert.equal(empty.run(page === 'PawShop.html' ? 'products.length' : 'loadProducts().length'), 0);
  });

  test(`${page}: malformed catalog responses preserve the saved list`, async () => {
    const app = boot(page, [{ id: 1, qty: 2 }]);
    await app.load({ error: 'unavailable' });
    assert.equal(app.storage.get('pawshop_cart'), '[{"id":1,"qty":2}]');
    const id = page === 'PawShop.html' ? 'productGrid' : 'pdp';
    assert.ok(app.nodes.get(id).innerHTML.includes('temporarily unavailable'));
  });
}

test('safe helpers reject malformed catalog fields and dangerous URL schemes', () => {
  const { context } = boot('PawShop.html');
  const safe = context.PawSafe;
  for (const input of ['', null, undefined, 'javascript:alert(1)', 'data:text/html,hi']) assert.equal(safe.url(input), '');
  assert.equal(safe.url('photo.png'), 'http://localhost:4173/pawshop/photo.png');
  assert.equal(safe.id('1);alert(1)'), 0);
  assert.equal(safe.quantity('NaN'), 1);
  assert.equal(safe.quantity(100000), 99);
  assert.equal(safe.catalog([null, {}, { ...product, price: '29' }, { ...product, stock: NaN }, { ...product, id: '1' }]).length, 0);
  const clean = safe.catalog([product, product]);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].originalPrice, product.price);
});
