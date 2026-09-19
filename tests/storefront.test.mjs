import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Contract tests for the storefront data layer: PawShop.html now renders the
// live Medusa catalog and a real guest cart instead of catalog.json. The page
// scripts run in a minimal DOM with a routed fetch, so the tests can assert
// exactly which requests the browser is allowed to make -- and, just as
// importantly, which ones it must never make (no checkout, no payment, no
// order, no customer account).
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

const EMPTY_CATALOG = { products: [], count: 0, offset: 0, limit: 50 };

function makeNode() {
  const classes = new Set();
  return {
    innerHTML: '', textContent: '', value: '', style: {}, placeholder: '',
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: name => (classes.has(name) ? classes.delete(name) : classes.add(name)),
      contains: name => classes.has(name),
    },
  };
}

function product(overrides = {}) {
  return {
    id: 'prod_1',
    title: 'Cardboard Cat Lounger',
    subtitle: '',
    description: 'A lounger.',
    thumbnail: null,
    images: [{ url: 'https://pawlivora-products-us-west-1.oss-us-west-1.aliyuncs.com/lounger.jpg' }],
    collection: null,
    type: null,
    variants: [{
      id: 'variant_1',
      title: 'Default',
      sku: 'PS-LOUNGER-01',
      calculated_price: { calculated_amount: 29.9, currency_code: 'usd' },
      inventory_quantity: 5,
      manage_inventory: true,
      allow_backorder: false,
    }],
    ...overrides,
  };
}

function cartPayload({ id = 'cart_1', items = [], subtotal = 0 } = {}) {
  return {
    cart: {
      id,
      currency_code: 'usd',
      region_id: 'reg_1',
      subtotal,
      shipping_total: 0,
      items,
    },
  };
}

function lineItem(overrides = {}) {
  return {
    id: 'li_1',
    product_title: 'Cardboard Cat Lounger',
    variant_title: 'Default',
    variant_sku: 'PS-LOUNGER-01',
    thumbnail: null,
    quantity: 1,
    unit_price: 29.9,
    ...overrides,
  };
}

// The production API answers these paths; a test can override any of them.
function defaultRoutes() {
  return {
    'GET /store/regions': () => ({ status: 200, body: { regions: [{ id: 'reg_1' }] } }),
    'GET /store/products': () => ({ status: 200, body: EMPTY_CATALOG }),
    'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
  };
}

function bootPawShop({ routes = {}, storage = new Map(), lang = 'en' } = {}) {
  const table = { ...defaultRoutes(), ...routes };
  const nodes = new Map();
  const calls = [];
  const store = new Map(storage);
  if (lang) store.set('pawshop_lang', lang);

  const context = vm.createContext({
    URL, URLSearchParams, console,
    location: { origin: 'https://pawlivora.com', href: 'https://pawlivora.com/PawShop.html', search: '' },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
    document: {
      title: '', body: { style: {} }, documentElement: {},
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, makeNode());
        return nodes.get(id);
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
    },
    addEventListener() {}, setTimeout: fn => fn(), clearTimeout() {},
    async fetch(url, options = {}) {
      const method = (options.method || 'GET').toUpperCase();
      const path = String(url).split('?')[0];
      calls.push({ method, path, url: String(url), options });
      const handler = table[`${method} ${path}`];
      if (!handler) throw new Error(`unrouted request: ${method} ${path}`);
      const result = typeof handler === 'function' ? handler(path, options) : handler;
      return {
        ok: result.status < 400,
        status: result.status,
        async json() { return result.body; },
      };
    },
  });
  context.window = context;

  for (const file of ['config.js', 'safe.js', 'store-api.js']) vm.runInContext(read(file), context);
  const source = read('PawShop.html');
  for (const match of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);

  return {
    context, nodes, calls, storage: store, source,
    run: code => vm.runInContext(code, context),
    // The page starts its bootstrap without awaiting it; drain the microtask
    // queue so assertions see a settled page.
    async settle() {
      for (let i = 0; i < 12; i++) await new Promise(setImmediate);
    },
    paths: () => calls.map(call => `${call.method} ${call.path}`),
  };
}

test('an empty shop says so instead of showing demo products', async () => {
  const app = bootPawShop();
  await app.settle();

  assert.equal(app.run('products.length'), 0);
  assert.equal(app.run('catalogState'), 'ready');
  const grid = app.nodes.get('productGrid').innerHTML;
  assert.ok(grid.includes('No products available for purchase yet'), grid);
  // The old prelaunch catalog must not be a fallback any more.
  assert.ok(!app.calls.some(call => call.url.includes('catalog.json')));
  assert.deepEqual(app.paths(), ['GET /store/regions', 'GET /store/products']);
});

test('an unreachable shop reports itself and keeps the stored cart id', async () => {
  const app = bootPawShop({
    storage: new Map([['pawshop_medusa_cart_id', 'cart_9']]),
    routes: {
      'GET /store/products': () => { throw new Error('offline'); },
      'GET /store/carts/cart_9': () => ({ status: 200, body: cartPayload({ id: 'cart_9', items: [lineItem()], subtotal: 29.9 }) }),
    },
  });
  await app.settle();

  assert.equal(app.run('products.length'), 0);
  assert.equal(app.run('catalogState'), 'unavailable');
  assert.ok(app.nodes.get('productGrid').innerHTML.includes('temporarily unavailable'));
  // A product-list outage must not silently throw the basket away.
  assert.equal(app.storage.get('pawshop_medusa_cart_id'), 'cart_9');
});

test('products render with real title, price, image and availability', async () => {
  const app = bootPawShop({
    routes: { 'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }) },
  });
  await app.settle();

  const grid = app.nodes.get('productGrid').innerHTML;
  assert.ok(grid.includes('Cardboard Cat Lounger'));
  assert.ok(grid.includes('$29.90'), grid);
  assert.ok(grid.includes('In stock'));
  assert.ok(grid.includes('pawlivora-products-us-west-1.oss-us-west-1.aliyuncs.com/lounger.jpg'));
});

test('catalog input cannot inject markup or fetch from an unknown host', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({
        status: 200,
        body: {
          products: [product({
            title: '<img src=x onerror=alert(1)>',
            images: [{ url: 'https://evil.example/tracker.gif' }, { url: 'javascript:alert(1)' }],
            variants: [{
              id: 'variant_1', title: 'Default', sku: 'SKU',
              calculated_price: { calculated_amount: 1 },
              inventory_quantity: 1, manage_inventory: true, allow_backorder: false,
            }],
          })],
          count: 1,
        },
      }),
    },
  });
  await app.settle();

  const grid = app.nodes.get('productGrid').innerHTML;
  assert.ok(grid.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!grid.includes('<img src=x'));
  assert.ok(!grid.includes('evil.example'));
  assert.ok(!grid.includes('javascript:'));
});

test('adding to cart creates a real cart, then a real line item', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({
        status: 200,
        body: cartPayload({ items: [lineItem()], subtotal: 29.9 }),
      }),
    },
  });
  await app.settle();
  await app.run("addToCart('prod_1')");

  assert.deepEqual(app.paths(), [
    'GET /store/regions',
    'GET /store/products',
    'POST /store/carts',
    'POST /store/carts/cart_1/line-items',
  ]);
  const createCart = app.calls.find(call => call.path === '/store/carts');
  assert.deepEqual(JSON.parse(createCart.options.body), { region_id: 'reg_1' });
  const lineItemCall = app.calls.find(call => call.path.endsWith('/line-items'));
  assert.deepEqual(JSON.parse(lineItemCall.options.body), { variant_id: 'variant_1', quantity: 1 });
  assert.equal(lineItemCall.options.method, 'POST');
  // The cart is remembered by its Medusa id, not by a cart this site invents.
  assert.equal(app.storage.get('pawshop_medusa_cart_id'), 'cart_1');

  const drawer = app.nodes.get('cartItems').innerHTML;
  assert.ok(drawer.includes('Cardboard Cat Lounger'));
  assert.ok(drawer.includes('PS-LOUNGER-01'), 'the line shows the SKU');
  assert.ok(drawer.includes('$29.90'));
  assert.equal(app.nodes.get('cartSubtotal').textContent, '$29.90');
  assert.equal(app.nodes.get('cartCount').textContent, 1);
  assert.equal(app.nodes.get('toastText').textContent, 'Added to cart');
});

test('a chosen variant is the one that gets added', async () => {
  const twoVariants = product({
    variants: [
      {
        id: 'variant_small', title: 'Small', sku: 'SKU-S',
        calculated_price: { calculated_amount: 19.9 }, inventory_quantity: 3,
        manage_inventory: true, allow_backorder: false,
      },
      {
        id: 'variant_large', title: 'Large', sku: 'SKU-L',
        calculated_price: { calculated_amount: 29.9 }, inventory_quantity: 0,
        manage_inventory: true, allow_backorder: false,
      },
    ],
  });
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [twoVariants], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 19.9 }) }),
    },
  });
  await app.settle();

  const grid = app.nodes.get('productGrid').innerHTML;
  assert.ok(grid.includes('From'), 'varying prices are advertised as a range');
  assert.ok(grid.includes('$19.90'));
  assert.ok(grid.includes('Out of stock'), 'a sold-out option is labelled');

  app.run("pickCardVariant('prod_1', 'variant_large')");
  await app.run("addToCart('prod_1')");
  const lineItemCall = app.calls.find(call => call.path.endsWith('/line-items'));
  assert.deepEqual(JSON.parse(lineItemCall.options.body), { variant_id: 'variant_large', quantity: 1 });
});

test('quantity changes and removals go through the Medusa cart', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/regions': () => ({ status: 200, body: { regions: [{ id: 'reg_1' }] } }),
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'GET /store/carts/cart_1': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'POST /store/carts/cart_1/line-items/li_1': () => ({ status: 200, body: cartPayload({ items: [lineItem({ quantity: 2 })], subtotal: 59.8 }) }),
      'DELETE /store/carts/cart_1/line-items/li_1': () => ({ status: 200, body: cartPayload() }),
    },
    storage: new Map([['pawshop_medusa_cart_id', 'cart_1']]),
  });
  await app.settle();
  assert.equal(app.nodes.get('cartCount').textContent, 1, 'the stored cart is restored on load');

  await app.run("changeQty('li_1', 1)");
  const update = app.calls.find(call => call.method === 'POST' && call.path.endsWith('/line-items/li_1'));
  assert.deepEqual(JSON.parse(update.options.body), { quantity: 2 });
  assert.equal(app.nodes.get('cartSubtotal').textContent, '$59.80');

  await app.run("changeQty('li_1', -2)");
  assert.ok(app.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/line-items/li_1')));
  assert.equal(app.nodes.get('cartCount').textContent, 0);
});

test('a cart that no longer exists is forgotten, not faked', async () => {
  const app = bootPawShop({
    storage: new Map([['pawshop_medusa_cart_id', 'cart_gone']]),
    routes: {
      'GET /store/carts/cart_gone': () => ({ status: 404, body: { message: 'Cart could not be found' } }),
    },
  });
  await app.settle();

  assert.equal(app.storage.has('pawshop_medusa_cart_id'), false);
  assert.equal(app.run('cart'), null);
  assert.ok(app.nodes.get('cartItems').innerHTML.includes('Your cart is empty'));
});

test('checkout cannot start an order or a payment', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
    },
  });
  await app.settle();
  await app.run("addToCart('prod_1')");
  const before = app.calls.length;

  app.run('checkout(); submitWaitlist();');
  assert.equal(app.calls.length, before, 'checkout must not call the shop');
  assert.equal(app.nodes.get('toastText').textContent, 'Checkout opens once payment is connected. No order was created.');
  assert.equal(app.run('PAWSHOP_PUBLIC_CONFIG.checkoutEnabled'), false);

  const surface = read('store-api.js') + read('PawShop.html');
  assert.ok(!/\/complete\b/.test(surface), 'no cart completion endpoint');
  assert.ok(!/payment[-_]?sessions?/i.test(surface), 'no payment session handling');
  assert.ok(!/emailpass|customer\/register/i.test(surface), 'no customer authentication');
});

test('the Chinese copy states the real state of the shop', async () => {
  const app = bootPawShop({ lang: 'zh' });
  await app.settle();

  assert.ok(app.nodes.get('productGrid').innerHTML.includes('暂无可购买商品'));
  app.run("openCart()");
  assert.ok(app.nodes.get('cartItems').innerHTML.includes('购物车是空的'));
  assert.equal(app.nodes.get('cartSubtotal').textContent, '$0.00');
});
