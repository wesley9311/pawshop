import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Contract tests for the storefront data layer: PawShop.html now renders the
// live Medusa catalog and a real guest cart instead of catalog.json. The page
// scripts run in a minimal DOM with a routed fetch, so the tests can assert
// exactly which requests the browser is allowed to make -- and, just as
// importantly, which ones it must never make (no checkout completion, no
// payment, no admin secrets; a customer may sign in but that is their own
// credential, never an admin/service token).
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

const EMPTY_CATALOG = { products: [], count: 0, offset: 0, limit: 50 };

function makeNode() {
  const classes = new Set();
  const attrs = new Map();
  return {
    innerHTML: '', textContent: '', value: '', style: {}, placeholder: '',
    dataset: {}, focused: false,
    focus() { this.focused = true; },
    scrollIntoView() {},
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
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

function cartPayload({ id = 'cart_1', items = [], subtotal = 0, item_subtotal, shipping_total = 0, total } = {}) {
  return {
    cart: {
      id,
      currency_code: 'usd',
      region_id: 'reg_1',
      subtotal,
      // Medusa's `subtotal` is goods + shipping; `item_subtotal` is goods only.
      item_subtotal: item_subtotal !== undefined ? item_subtotal : subtotal,
      shipping_total,
      total: total !== undefined ? total : subtotal,
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

test('a completed cart (order already placed) is forgotten, not reused', async () => {
  const completed = cartPayload({ id: 'cart_done', items: [lineItem()], subtotal: 29.9 });
  completed.cart.completed_at = '2026-09-28T08:03:56.531Z';
  const app = bootPawShop({
    storage: new Map([['pawshop_medusa_cart_id', 'cart_done']]),
    routes: {
      // A completed cart still answers 200 with completed_at set (not 404).
      'GET /store/carts/cart_done': () => ({ status: 200, body: completed }),
    },
  });
  await app.settle();

  assert.equal(app.storage.has('pawshop_medusa_cart_id'), false, 'completed cart id is cleared');
  assert.equal(app.run('cart'), null);
  assert.ok(app.nodes.get('cartItems').innerHTML.includes('Your cart is empty'));
});

test('adding to a cart that got completed mid-session starts a fresh cart and retries', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload({ id: 'cart_new' }) }),
      // At load the cart is still open, so it restores fine.
      'GET /store/carts/cart_1': () => ({ status: 200, body: cartPayload({ id: 'cart_1', items: [lineItem()], subtotal: 29.9 }) }),
      // By the time the buyer adds, the cart has been completed (webhook placed
      // the order), so the first add is refused and a fresh cart is used.
      'POST /store/carts/cart_1/line-items': () => ({ status: 400, body: { type: 'invalid_data', message: 'Cart cart_1 is already completed.' } }),
      'POST /store/carts/cart_new/line-items': () => ({ status: 200, body: cartPayload({ id: 'cart_new', items: [lineItem()], subtotal: 29.9 }) }),
    },
    storage: new Map([['pawshop_medusa_cart_id', 'cart_1']]),
  });
  await app.settle();

  await app.run("addToCart('prod_1')");
  await app.settle();

  // The completed cart was dropped and the add retried on a fresh cart.
  assert.ok(app.calls.some(call => call.path === '/store/carts/cart_new/line-items'), 'add retried on a fresh cart');
  assert.equal(app.storage.get('pawshop_medusa_cart_id'), 'cart_new', 'new cart id persisted');
  assert.equal(app.nodes.get('cartCount').textContent, 1);
});

test('checkout writes cart data but can never complete a cart or expose admin secrets', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [] } }),
      'POST /store/carts/cart_1': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
    },
  });
  await app.settle();
  await app.run("addToCart('prod_1')");

  // Opening checkout is allowed to read the cart's shipping options.
  await app.run('checkout()');
  await app.settle();
  assert.ok(app.calls.some(call => call.path === '/store/shipping-options'), 'checkout reads shipping options');

  const surface = read('store-api.js') + read('PawShop.html');
  // The hard boundaries: the page may never complete a cart itself (the order
  // is created only by the provider's webhook), and it may never expose admin
  // secrets. Customer *login* is now legitimate (Account Experience Phase 1:
  // /auth/customer/emailpass), but that is the shopper's own credential, never
  // an admin secret or a service token.
  assert.ok(!/\/complete\b/.test(surface), 'no cart completion endpoint');
  assert.ok(!/completeCart/i.test(surface), 'no completeCart reference');
  // The system provider must never leak into the storefront.
  assert.ok(!/pp_system/i.test(surface), 'no system payment provider');
});

test('place order creates a payment session and hands off to PayPal, never completing the cart', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [{ id: 'so_1', name: 'Standard Shipping', amount: 9.9 }] } }),
      'POST /store/carts/cart_1/shipping-methods': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9 }) }),
      'POST /store/carts/cart_1': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9 }) }),
      'POST /store/payment-collections': () => ({ status: 200, body: { payment_collection: { id: 'paycol_1' } } }),
      'POST /store/payment-collections/paycol_1/payment-sessions': () => ({
        status: 200,
        body: {
          payment_collection: {
            id: 'paycol_1',
            payment_sessions: [{ id: 'payses_1', provider_id: 'pp_paypal_paypal', data: { approval_url: 'https://www.sandbox.paypal.com/checkoutnow?token=abc' } }],
          },
        },
      }),
    },
  });
  await app.settle();
  await app.run("addToCart('prod_1')");
  await app.run('checkout()');
  await app.settle();
  await app.run("pickShippingOption('so_1')");
  await app.settle();

  app.run(`
    document.getElementById('coEmail').value = 'buyer@example.com';
    document.getElementById('coFirst').value = 'Ada';
    document.getElementById('coLast').value = 'Lovelace';
    document.getElementById('coAddress1').value = '1 Main St';
    document.getElementById('coCity').value = 'San Francisco';
    document.getElementById('coProvince').value = 'CA';
    document.getElementById('coPostal').value = '94107';
    document.getElementById('coCountry').value = 'US';
  `);

  const before = app.calls.length;
  await app.run('placeOrder()');
  await app.settle();

  // Email and address are written back to the real cart.
  assert.ok(app.calls.some(call => call.method === 'POST' && call.path === '/store/carts/cart_1'), 'email/address write back to the cart');
  // A payment collection and a PayPal payment session are created.
  assert.ok(app.calls.some(call => call.method === 'POST' && call.path === '/store/payment-collections'), 'payment collection created');
  assert.ok(app.calls.some(call => call.method === 'POST' && call.path === '/store/payment-collections/paycol_1/payment-sessions'), 'PayPal payment session created');
  // The buyer is handed off to PayPal's approval URL (same-tab redirect).
  assert.equal(app.run('location.href'), 'https://www.sandbox.paypal.com/checkoutnow?token=abc');
  // The cart id + email are remembered for the post-approval order lookup.
  assert.ok(app.storage.get('pawshop_order_lookup').includes('buyer@example.com'), 'email remembered for lookup');
  // The page never completes the cart itself — the order is webhook-created.
  assert.ok(!app.calls.some(call => /\/complete\b/.test(call.path)), 'no completion request');
});

test('place order stops at the honest boundary when no provider is available', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [{ id: 'so_1', name: 'Standard Shipping', amount: 9.9 }] } }),
      'POST /store/carts/cart_1/shipping-methods': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9 }) }),
      'POST /store/carts/cart_1': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9 }) }),
      // The region has no payment provider: creating a payment collection fails
      // (or returns no id), so the page must fall back to the honest boundary.
      'POST /store/payment-collections': () => ({ status: 400, body: { type: 'not_allowed', message: 'Payment provider is not enabled in the region' } }),
    },
  });
  await app.settle();
  await app.run("addToCart('prod_1')");
  await app.run('checkout()');
  await app.settle();
  await app.run("pickShippingOption('so_1')");
  await app.settle();
  app.run(`
    document.getElementById('coEmail').value = 'buyer@example.com';
    document.getElementById('coFirst').value = 'Ada';
    document.getElementById('coLast').value = 'Lovelace';
    document.getElementById('coAddress1').value = '1 Main St';
    document.getElementById('coCity').value = 'San Francisco';
    document.getElementById('coProvince').value = 'CA';
    document.getElementById('coPostal').value = '94107';
    document.getElementById('coCountry').value = 'US';
  `);

  await app.run('placeOrder()');
  await app.settle();

  // No payment session, no completion — the boundary panel explains it.
  assert.ok(!app.calls.some(call => /payment[-_]?sessions?/.test(call.path)), 'no payment session request');
  const body = app.nodes.get('checkoutBody').innerHTML;
  assert.ok(body.includes('Payment is not connected yet'), 'boundary panel explains no order was created');
  assert.ok(body.includes('no order was created'), 'boundary panel is explicit that nothing happened');
});

test('the Chinese copy states the real state of the shop', async () => {
  const app = bootPawShop({ lang: 'zh' });
  await app.settle();

  assert.ok(app.nodes.get('productGrid').innerHTML.includes('暂无可购买商品'));
  app.run("openCart()");
  assert.ok(app.nodes.get('cartItems').innerHTML.includes('购物车是空的'));
  assert.equal(app.nodes.get('cartSubtotal').textContent, '$0.00');
});

test('selecting a shipping method keeps the typed email and address fields', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [{ id: 'so_1', name: 'Standard Shipping', amount: 9.9 }] } }),
      // The cart returned by selectShippingMethod has NO email/address yet —
      // they are only written back at placeOrder(). The render must not use
      // this empty server state to blank the visitor's draft.
      'POST /store/carts/cart_1/shipping-methods': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9, item_subtotal: 29.9, total: 39.8 }) }),
      'POST /store/carts/cart_1': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9, item_subtotal: 29.9, total: 39.8 }) }),
    },
  });
  await app.settle();
  await app.run("addToCart('prod_1')");
  await app.run('checkout()');
  await app.settle();

  // Simulate the visitor typing: each keystroke fires `input`, which writes the
  // draft AND the DOM value in lockstep (in a real browser the DOM value is
  // what the visitor typed). We set both so the subsequent render is faithful.
  app.run(`
    setDraft('email', 'buyer@example.com'); document.getElementById('coEmail').value = 'buyer@example.com';
    setDraft('firstName', 'Ada'); document.getElementById('coFirst').value = 'Ada';
    setDraft('lastName', 'Lovelace'); document.getElementById('coLast').value = 'Lovelace';
    setDraft('address1', '1 Main St'); document.getElementById('coAddress1').value = '1 Main St';
    setDraft('city', 'San Francisco'); document.getElementById('coCity').value = 'San Francisco';
    setDraft('province', 'CA'); document.getElementById('coProvince').value = 'CA';
    setDraft('postalCode', '94107'); document.getElementById('coPostal').value = '94107';
    setDraft('countryCode', 'us'); document.getElementById('coCountry').value = 'US';
  `);

  // Selecting a shipping method re-renders the whole checkout form. The
  // server cart it returns has no email/address, so a buggy render that reads
  // cart.email would blank every field back to its placeholder.
  await app.run("pickShippingOption('so_1')");
  await app.settle();

  assert.equal(app.run('checkoutDraft.email'), 'buyer@example.com', 'email survives shipping-method re-render');
  assert.equal(app.run('checkoutDraft.firstName'), 'Ada', 'first name survives');
  assert.equal(app.run('checkoutDraft.address1'), '1 Main St', 'address survives');
  assert.equal(app.run('checkoutDraft.city'), 'San Francisco', 'city survives');
  assert.equal(app.run('checkoutDraft.province'), 'CA', 'state survives');
  assert.equal(app.run('checkoutDraft.postalCode'), '94107', 'ZIP survives');

  // The order summary must decompose goods vs shipping: Subtotal is the goods
  // only ($29.90), not goods+shipping ($39.80).
  const summary = app.nodes.get('checkoutBody').innerHTML;
  assert.ok(summary.includes('$29.90'), 'subtotal shows the item subtotal, not goods+shipping');
  assert.ok(summary.includes('$39.80'), 'total includes shipping');
});

test('shipping-method switch must not reset the email field the visitor already typed', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({
        status: 200,
        body: { shipping_options: [{ id: 'so_1', name: 'Standard Shipping', amount: 9.9 }, { id: 'so_2', name: 'Express Shipping', amount: 19.9 }] },
      }),
      'POST /store/carts/cart_1/shipping-methods': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9, item_subtotal: 29.9, total: 39.8 }) }),
    },
  });
  await app.settle();
  await app.run("addToCart('prod_1')");
  await app.run('checkout()');
  await app.settle();

  // The visitor has typed an email but has NOT yet touched the address fields.
  app.run(`
    setDraft('email', 'owner@pawlivora.com');
    document.getElementById('coEmail').value = 'owner@pawlivora.com';
  `);

  await app.run("pickShippingOption('so_1')");
  await app.settle();

  // The email must still be there; only the shipping method changed.
  assert.equal(app.run('checkoutDraft.email'), 'owner@pawlivora.com', 'email is not reset by a shipping switch');
});

// The order payload the guest lookup returns, matching the production
// /pawshop-orders/lookup response shape.
function orderPayload(overrides = {}) {
  return {
    order: {
      order_number: 1001,
      public_order_number: 'PS-20260928-1001',
      status: 'completed',
      payment_status: 'captured',
      fulfillment_status: 'not_fulfilled',
      currency_code: 'usd',
      total: 39.8,
      created_at: '2026-09-28T12:00:00.000Z',
      email: 'buyer@example.com',
      items: [{ title: 'Cardboard Cat Lounger', quantity: 1, unit_price: 29.9, total: 29.9, thumbnail: null }],
      shipping_method: 'Standard Shipping',
      shipping_amount: 9.9,
      shipping_address: {
        first_name: 'Ada', last_name: 'Lovelace',
        address_1: '1 Main St', address_2: null,
        city: 'San Francisco', province: 'CA', postal_code: '94107', country_code: 'us',
      },
      ...overrides,
    },
  };
}

test('an order detail renders every real field without inventing a tracking entry', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'GET /store/pawshop-orders/lookup': () => ({ status: 200, body: orderPayload() }),
    },
  });
  await app.settle();

  // Open the lookup, pre-fill the real number + email, then submit.
  app.run("renderOrderLookupForm('buyer@example.com', '1001')");
  app.run("document.getElementById('lookupNumber').value = '1001'; document.getElementById('lookupEmail').value = 'buyer@example.com';");
  await app.run("submitOrderLookup()");
  await app.settle();

  const html = app.nodes.get('orderBody').innerHTML;
  assert.ok(html.includes('PS-20260928-1001'), 'public order number is shown as the primary order number');
  assert.ok(html.includes('buyer@example.com'), 'checkout email is shown');
  assert.ok(html.includes('Cardboard Cat Lounger'), 'item summary is shown');
  assert.ok(html.includes('$39.80'), 'total is shown');
  assert.ok(html.includes('Paid'), 'payment status is shown');
  assert.ok(html.includes('Standard Shipping'), 'shipping method is shown');
  assert.ok(html.includes('Not yet shipped'), 'fulfillment status is shown');
  assert.ok(html.includes('Ada Lovelace'), 'shipping name is shown');
  assert.ok(html.includes('1 Main St'), 'shipping address is shown');
  assert.ok(html.includes('San Francisco'), 'shipping city is shown');
  assert.ok(html.includes('94107'), 'shipping postal code is shown');
  // No fulfillment / carrier / tracking entry exists yet.
  assert.ok(!html.toLowerCase().includes('track shipment'), 'no tracking entry');
  assert.ok(!html.toLowerCase().includes('tracking number'), 'no tracking number');
});

test('the success page offers "view order" that resolves straight to the detail (no lookup flash)', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'GET /store/pawshop-orders/lookup': () => ({ status: 200, body: orderPayload() }),
    },
  });
  await app.settle();

  // Render the success page directly (as handlePayPalReturn does after the
  // order resolves).
  app.run(`renderOrderSuccess(${JSON.stringify(orderPayload().order)})`);

  const html = app.nodes.get('orderBody').innerHTML;
  assert.ok(html.includes('Payment confirmed'), 'success page confirms payment (not "Order placed")');
  assert.ok(html.includes('Your order has been created successfully'), 'success page confirms the order was created');
  assert.ok(html.includes('PS-20260928-1001'), 'success page shows the public order number');
  assert.ok(html.includes('$39.80'), 'success page shows the total');
  assert.ok(!html.includes('Paid'), 'success page never says "Paid" (AUTHORIZE flow, not captured)');
  assert.ok(!html.includes('captured'), 'success page does NOT expose the raw lifecycle value');
  assert.ok(!html.includes('authorized'), 'success page does NOT expose the raw lifecycle value');
  assert.ok(html.includes('Standard Shipping'), 'success page shows the shipping method');
  assert.ok(html.includes('View order'), 'success page offers a view-order button');
  assert.ok(html.includes('Continue shopping'), 'success page offers a continue-shopping button');
  assert.ok(!html.includes('Back to shop'), 'success page does NOT use the "back to shop" wording');

  // Clicking "view order" must resolve the order we already hold straight into
  // the detail view — it must NOT render the guest-lookup form in between (no
  // order-number/email inputs flash on screen).
  await app.run('openOrderLookupFromSuccess()');
  await app.settle();

  const detail = app.nodes.get('orderBody').innerHTML;
  assert.ok(detail.includes('PS-20260928-1001'), 'view order lands on the same order detail');
  assert.ok(detail.includes('Cardboard Cat Lounger'), 'detail carries the item list');
  assert.equal(app.nodes.get('lookupNumber'), undefined, 'no guest-lookup number input is rendered in between');
  assert.equal(app.nodes.get('lookupEmail'), undefined, 'no guest-lookup email input is rendered in between');
});

test('the success page is a light confirmation and does not duplicate the order detail', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'GET /store/pawshop-orders/lookup': () => ({ status: 200, body: orderPayload() }),
    },
  });
  await app.settle();

  const order = orderPayload().order;
  app.run(`renderOrderSuccess(${JSON.stringify(order)})`);
  const successHtml = app.nodes.get('orderBody').innerHTML;

  // The success page must NOT repeat the full item list, the shipping address,
  // the checkout email, or the fulfillment/order status — those belong to the
  // order detail only.
  assert.ok(!successHtml.includes('Cardboard Cat Lounger'), 'success page omits the item list');
  assert.ok(!successHtml.includes('1 Main St'), 'success page omits the shipping address');
  assert.ok(!successHtml.includes('buyer@example.com'), 'success page omits the checkout email');
  assert.ok(!successHtml.includes('Not yet shipped'), 'success page omits the fulfillment status');

  // The detail view, reached through the lookup, carries all of them.
  app.run(`renderOrderDetail(${JSON.stringify(order)})`);
  const detailHtml = app.nodes.get('orderBody').innerHTML;
  assert.ok(detailHtml.includes('Cardboard Cat Lounger'), 'detail shows the item list');
  assert.ok(detailHtml.includes('1 Main St'), 'detail shows the shipping address');
  assert.ok(detailHtml.includes('buyer@example.com'), 'detail shows the checkout email');
  assert.ok(detailHtml.includes('Not yet shipped'), 'detail shows the fulfillment status');
  assert.ok(detailHtml.includes('Ada Lovelace'), 'detail shows the shipping name');
});

test('the lookup normalizes "6", "#6", and "PS-..." to a resolvable order number', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'GET /store/pawshop-orders/lookup': () => ({ status: 200, body: orderPayload() }),
    },
  });
  await app.settle();

  // Each human-typed form reduces to the same canonical value.
  assert.equal(app.run("normalizeLookupNumber('6')"), '6', 'raw display_id stays');
  assert.equal(app.run("normalizeLookupNumber('#6')"), '6', '"#6" strips the hash');
  assert.equal(app.run("normalizeLookupNumber('PS-20260929-0006')"), 'PS-20260929-0006', 'public number is kept');
  assert.equal(app.run("normalizeLookupNumber('  #6  ')"), '6', 'whitespace + hash still normalize');
  assert.equal(app.run("normalizeLookupNumber('PS-20260929-6')"), 'PS-20260929-6', 'unpadded public number is kept');
  assert.equal(app.run("normalizeLookupNumber('abc')"), '', 'garbage yields empty (backend 404s)');
  assert.equal(app.run("normalizeLookupNumber('')"), '', 'empty yields empty');
});

test('submitting "#6" sends the canonical bare display_id to the lookup', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'GET /store/pawshop-orders/lookup': () => ({ status: 200, body: orderPayload({ order_number: 6, public_order_number: 'PS-20260929-0006' }) }),
    },
  });
  await app.settle();

  app.run("renderOrderLookupForm('buyer@example.com')");
  app.run("document.getElementById('lookupNumber').value = '#6'; document.getElementById('lookupEmail').value = 'buyer@example.com';");
  await app.run('submitOrderLookup()');
  await app.settle();

  // The request must carry a bare "6", not "#6", so the backend can resolve it.
  const lookupCall = app.calls.find(c => c.path === '/store/pawshop-orders/lookup');
  assert.ok(lookupCall, 'a lookup request was made');
  assert.ok(lookupCall.url.includes('order_number=6'), 'lookup is sent the bare display_id, not "#6"');
  assert.ok(!lookupCall.url.includes('%23'), 'the hash is never URL-encoded into the query');
});

// ===== Phase 1 logistics: real shipments and tracking =====
// The guest lookup returns one entry per Medusa fulfillment, carrying that
// fulfillment's real timestamps and the labels that hold tracking numbers.
// The UI renders only what is there: it must never turn "packed" into
// "shipped", never invent a carrier, and never invent an in-transit or
// out-for-delivery step that Medusa has no data for.
function fulfillment(overrides = {}) {
  return {
    id: 'ful_1',
    created_at: '2026-09-29T10:00:00.000Z',
    packed_at: null,
    shipped_at: null,
    delivered_at: null,
    canceled_at: null,
    labels: [],
    ...overrides,
  };
}

const TRACKING_URL = 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490';
const trackingLabel = (overrides = {}) => ({
  tracking_number: '9400111899223197428490',
  tracking_url: TRACKING_URL,
  ...overrides,
});

// Render an order detail straight from a payload and return the markup. The
// detail view is the same function the lookup and "View order" both reach.
async function detailFor(order) {
  const app = bootPawShop({
    routes: { 'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }) },
  });
  await app.settle();
  app.run(`renderOrderDetail(${JSON.stringify(order)})`);
  return app.nodes.get('orderBody').innerHTML;
}

test('an order with no fulfillment renders no shipment block at all', async () => {
  const html = await detailFor(orderPayload().order);

  assert.ok(!html.includes('Shipments'), 'no shipments heading');
  assert.ok(!html.includes('Track shipment'), 'no track link');
  assert.ok(!html.includes('Tracking number'), 'no tracking number row');
});

test('a packed-but-not-shipped fulfillment reads "Packed", never "Shipped"', async () => {
  const html = await detailFor(orderPayload({
    fulfillment_status: 'fulfilled',
    fulfillments: [fulfillment({ packed_at: '2026-09-29T10:00:00.000Z' })],
  }).order);

  assert.ok(html.includes('>Packed<'), 'the package shows its real packed state');
  assert.ok(!html.includes('>Shipped<'), 'packed must never be presented as shipped');
  assert.ok(!html.includes('Track shipment'), 'a package with no tracking number gets no link');
  assert.ok(html.includes('Shipments'), 'the shipment block is present');
});

test('a shipped fulfillment shows the real tracking number and a track link', async () => {
  const html = await detailFor(orderPayload({
    fulfillment_status: 'shipped',
    fulfillments: [fulfillment({
      packed_at: '2026-09-29T10:00:00.000Z',
      shipped_at: '2026-09-30T08:00:00.000Z',
      labels: [trackingLabel()],
    })],
  }).order);

  assert.ok(html.includes('>Shipped<'), 'the package shows its real shipped state');
  assert.ok(html.includes('9400111899223197428490'), 'the real tracking number is shown');
  assert.ok(html.includes('Track shipment'), 'a track link is offered when a URL exists');
  assert.ok(html.includes('tools.usps.com'), 'the real tracking URL is emitted');
  assert.ok(html.includes('rel="noopener noreferrer"'), 'external links are opened safely');
});

test('a delivered fulfillment reads "Delivered"', async () => {
  const html = await detailFor(orderPayload({
    fulfillment_status: 'delivered',
    fulfillments: [fulfillment({
      packed_at: '2026-09-29T10:00:00.000Z',
      shipped_at: '2026-09-30T08:00:00.000Z',
      delivered_at: '2026-10-02T14:00:00.000Z',
      labels: [trackingLabel()],
    })],
  }).order);

  assert.ok(html.includes('>Delivered<'), 'the package shows its real delivered state');
  assert.ok(!html.includes('>Shipped<'), 'delivered is not also labelled shipped');
});

test('multiple fulfillments render one card each with every tracking number', async () => {
  const html = await detailFor(orderPayload({
    fulfillment_status: 'shipped',
    fulfillments: [
      fulfillment({ id: 'ful_a', shipped_at: '2026-09-30T08:00:00.000Z', labels: [trackingLabel({ tracking_number: 'AAA111' })] }),
      fulfillment({ id: 'ful_b', created_at: '2026-09-30T09:00:00.000Z', shipped_at: '2026-10-01T08:00:00.000Z', labels: [trackingLabel({ tracking_number: 'BBB222' })] }),
    ],
  }).order);

  assert.ok(html.includes('Shipment #1'), 'first package is listed');
  assert.ok(html.includes('Shipment #2'), 'second package is listed');
  assert.ok(html.includes('AAA111'), 'first tracking number is shown');
  assert.ok(html.includes('BBB222'), 'second tracking number is shown — one order can have many');
});

test('a partially shipped order shows the order-level status and each package state', async () => {
  const html = await detailFor(orderPayload({
    fulfillment_status: 'partially_shipped',
    fulfillments: [
      fulfillment({ id: 'ful_a', shipped_at: '2026-09-30T08:00:00.000Z', labels: [trackingLabel({ tracking_number: 'AAA111' })] }),
      fulfillment({ id: 'ful_b', created_at: '2026-09-30T09:00:00.000Z', packed_at: '2026-09-30T09:30:00.000Z' }),
    ],
  }).order);

  assert.ok(html.includes('>Partially shipped<'), 'the order-level status is the real partial one');
  assert.ok(html.includes('>Shipped<'), 'the shipped package reads shipped');
  assert.ok(html.includes('>Packed<'), 'the other package reads packed');
});

test('a tracking number without a URL still renders, and offers no link', async () => {
  const html = await detailFor(orderPayload({
    fulfillment_status: 'shipped',
    fulfillments: [fulfillment({
      shipped_at: '2026-09-30T08:00:00.000Z',
      labels: [trackingLabel({ tracking_url: null })],
    })],
  }).order);

  assert.ok(html.includes('9400111899223197428490'), 'the number is still shown');
  assert.ok(!html.includes('Track shipment'), 'no link is fabricated when there is no URL');
});

test('a tracking URL that is not http(s) is never emitted', async () => {
  const html = await detailFor(orderPayload({
    fulfillment_status: 'shipped',
    fulfillments: [fulfillment({
      shipped_at: '2026-09-30T08:00:00.000Z',
      labels: [trackingLabel({ tracking_url: 'javascript:alert(1)' })],
    })],
  }).order);

  assert.ok(!html.includes('javascript:'), 'a javascript: URL never reaches the page');
  assert.ok(!html.includes('Track shipment'), 'an unusable URL yields no link');
  assert.ok(html.includes('9400111899223197428490'), 'the real number is still shown');
});

test('labels.label_url is never rendered, even if the payload carries one', async () => {
  const html = await detailFor(orderPayload({
    fulfillment_status: 'shipped',
    fulfillments: [fulfillment({
      shipped_at: '2026-09-30T08:00:00.000Z',
      labels: [{ ...trackingLabel(), label_url: 'https://internal.example/label.pdf' }],
    })],
  }).order);

  assert.ok(!html.includes('internal.example'), 'the shipping-label artifact stays out of the storefront');
  assert.ok(!html.includes('label_url'), 'label_url is not surfaced');
  assert.ok(html.includes('9400111899223197428490'), 'the tracking number is still shown');
});

test('a canceled fulfillment reads as a canceled fulfillment', async () => {
  const html = await detailFor(orderPayload({
    fulfillment_status: 'canceled',
    fulfillments: [fulfillment({ canceled_at: '2026-09-30T08:00:00.000Z' })],
  }).order);

  assert.ok(html.includes('>Fulfillment canceled<'), 'the real canceled state is named');
});

test('the storefront never invents an in-transit or out-for-delivery step', async () => {
  const html = await detailFor(orderPayload({
    fulfillment_status: 'shipped',
    fulfillments: [fulfillment({ shipped_at: '2026-09-30T08:00:00.000Z', labels: [trackingLabel()] })],
  }).order);

  const lower = html.toLowerCase();
  assert.ok(!lower.includes('in transit'), 'no in-transit step without a carrier event source');
  assert.ok(!lower.includes('out for delivery'), 'no out-for-delivery step without a carrier event source');
  assert.ok(!lower.includes('delivering'), 'no delivering step without a carrier event source');
});

// ===== Guest lookup: one indistinguishable failure state =====
// Anti-enumeration is a property of the whole path, not just the server: the
// lookup collapses *any* 404 — a nonexistent order, a mismatched email, a
// malformed query — to the same null, and the UI renders one state from it.
// These tests pin that the buyer cannot read a distinction out of the screen.
const NOT_FOUND_LOOKUP = {
  'GET /store/pawshop-orders/lookup': () => ({ status: 404, body: { type: 'not_found' } }),
};

// Fill the lookup form, submit it, and return the rendered order panel.
async function submitLookup(number, email) {
  const app = bootPawShop({ routes: NOT_FOUND_LOOKUP });
  await app.settle();
  app.run('renderOrderLookupForm()');
  app.context.document.getElementById('lookupNumber').value = number;
  app.context.document.getElementById('lookupEmail').value = email;
  await app.context.submitOrderLookup();
  return { html: app.nodes.get('orderBody').innerHTML, app };
}

test('a nonexistent order and a wrong email render the identical not-found state', async () => {
  const nonexistent = await submitLookup('9999', 'buyer@example.com');
  const wrongEmail = await submitLookup('6', 'someone.else@example.com');

  assert.equal(
    nonexistent.html,
    wrongEmail.html,
    'the screen must not reveal whether the order number or the email was wrong',
  );
  assert.ok(nonexistent.html.includes('We could not find an order with those details.'));
  assert.ok(nonexistent.html.includes('Check again'), 'the buyer can retry');
  // No distinction leaks as a different status word, error code or raw body.
  for (const leak of ['not_found', '404', 'type']) {
    assert.ok(!nonexistent.html.includes(leak), `the 404 body must not leak "${leak}"`);
  }
});

test('the lookup never reaches the order detail view on a miss', async () => {
  const { html, app } = await submitLookup('6', 'buyer@example.com');
  // A miss must not render any part of the real order detail shell.
  assert.ok(!html.includes('order_payment_status') && !html.includes('Payment status'));
  assert.ok(!html.includes('Shipment'));
  assert.deepEqual(app.paths().filter(p => p.includes('pawshop-orders')), ['GET /store/pawshop-orders/lookup']);
});

test('a lookup network outage is reported, never mistaken for "no such order"', async () => {
  const app = bootPawShop({
    routes: { 'GET /store/pawshop-orders/lookup': () => { throw new Error('offline'); } },
  });
  await app.settle();
  app.run('renderOrderLookupForm()');
  app.context.document.getElementById('lookupNumber').value = '6';
  app.context.document.getElementById('lookupEmail').value = 'buyer@example.com';
  await app.context.submitOrderLookup();

  const html = app.nodes.get('orderBody').innerHTML;
  assert.ok(
    !html.includes('We could not find an order with those details.'),
    'an outage is not the buyer\'s mistake and must not be shown as "order not found"',
  );
});

// ===== Checkout Country / Address UX =====
// A region whose shippable list is authoritative: the US only (the current
// pilot). Tests override this to exercise multi-country and unsupported cases.
function regionRoute(countries) {
  return () => ({
    status: 200,
    body: {
      regions: [{
        id: 'reg_1',
        name: 'United States',
        currency_code: 'usd',
        countries: countries.map(c => ({ iso_2: c.code, display_name: c.name })),
      }],
    },
  });
}
const US_ONLY = [{ code: 'us', name: 'United States' }];

// A checkout helper that seeds a cart with one line item and opens checkout so
// the address form and shipping options are populated.
async function openCheckout(app) {
  await app.settle();
  await app.run("addToCart('prod_1')");
  await app.run('checkout()');
  await app.settle();
}

test('checkout recommends the configured default country and preselects it', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [] } }),
      'GET /store/regions': regionRoute(US_ONLY),
    },
  });
  await openCheckout(app);

  // The default country is the configured recommendation, and it is preselected
  // in the country control without the visitor having typed anything.
  assert.equal(app.run('checkoutDraft.countryCode'), 'us', 'recommended country is preselected in the draft');
  assert.equal(app.run('recommendedCountryCode()'), 'us', 'recommendedCountryCode resolves the shippable default');
  const body = app.nodes.get('checkoutBody').innerHTML;
  assert.ok(body.includes('United States'), 'the country selector lists the shippable country');
  assert.ok(body.includes('coCountry'), 'a country control is rendered');
});

test('the country selector offers every shippable country and is switchable', async () => {
  const twoCountries = [{ code: 'us', name: 'United States' }, { code: 'ca', name: 'Canada' }];
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [] } }),
      'GET /store/regions': regionRoute(twoCountries),
    },
  });
  await openCheckout(app);

  const body = app.nodes.get('checkoutBody').innerHTML;
  assert.ok(body.includes('United States'), 'US is offered');
  assert.ok(body.includes('Canada'), 'Canada is offered');

  // Switching to Canada updates the draft and clears a US-specific state, since
  // a US state code no longer applies. The country is never locked to the default.
  await app.run("onCountryChange('ca')");
  await app.settle();
  assert.equal(app.run('checkoutDraft.countryCode'), 'ca', 'country switch updates the draft');
  assert.equal(app.run('checkoutDraft.province'), '', 'a US state is dropped when switching to Canada');
  assert.equal(app.run('isShippableCountry("ca")'), true, 'Canada is shippable in this fixture');
});

test('a US address requires a real state code and rejects an invalid one', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [] } }),
      'GET /store/regions': regionRoute(US_ONLY),
    },
  });
  await openCheckout(app);

  // A made-up state code is rejected; a real one is accepted.
  const bad = app.run(`validateAddress({ firstName: 'A', lastName: 'B', address1: '1 Main St', city: 'X', province: 'ZZ', postalCode: '94107', countryCode: 'us' })`);
  assert.ok(bad.province, 'an invalid US state is flagged');
  const good = app.run(`validateAddress({ firstName: 'A', lastName: 'B', address1: '1 Main St', city: 'X', province: 'CA', postalCode: '94107', countryCode: 'us' })`);
  assert.ok(!good.province, 'a valid US state passes');
});

test('a US ZIP is structurally validated (ZIP and ZIP+4)', async () => {
  const app = bootPawShop({ routes: { 'GET /store/regions': regionRoute(US_ONLY) } });
  await app.settle();
  const base = { firstName: 'A', lastName: 'B', address1: '1 Main St', city: 'X', province: 'CA', countryCode: 'us' };

  assert.ok(!app.run(`validateAddress({ ...${JSON.stringify(base)}, postalCode: '94107' })`).postalCode, '5-digit ZIP passes');
  assert.ok(!app.run(`validateAddress({ ...${JSON.stringify(base)}, postalCode: '94107-1234' })`).postalCode, 'ZIP+4 passes');
  assert.ok(app.run(`validateAddress({ ...${JSON.stringify(base)}, postalCode: '1234' })`).postalCode, 'too-short ZIP rejected');
  assert.ok(app.run(`validateAddress({ ...${JSON.stringify(base)}, postalCode: 'abcde' })`).postalCode, 'non-numeric ZIP rejected');
});

test('changing the country reloads shipping options for the new destination', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [{ id: 'so_1', name: 'Standard Shipping', amount: 9.9 }] } }),
      'GET /store/regions': regionRoute([{ code: 'us', name: 'United States' }, { code: 'ca', name: 'Canada' }]),
    },
  });
  await openCheckout(app);
  const callsBefore = app.calls.filter(c => c.path === '/store/shipping-options').length;

  await app.run("onCountryChange('ca')");
  await app.settle();

  const callsAfter = app.calls.filter(c => c.path === '/store/shipping-options').length;
  assert.ok(callsAfter > callsBefore, 'changing the country re-queries shipping options');
});

test('an unsupported destination is refused before payment', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [] } }),
      'GET /store/regions': regionRoute(US_ONLY),
    },
  });
  await openCheckout(app);

  // Force a non-shippable country into the draft and try to pay.
  app.run(`
    checkoutDraft.countryCode = 'jp';
    checkoutDraft.firstName = 'A'; checkoutDraft.lastName = 'B';
    checkoutDraft.address1 = '1 Main St'; checkoutDraft.city = 'Tokyo';
    checkoutDraft.province = 'Tokyo'; checkoutDraft.postalCode = '100-0001';
    checkoutDraft.email = 'buyer@example.com';
  `);
  await app.run('placeOrder()');
  await app.settle();

  // No payment collection and no cart write: the unsupported country is blocked.
  assert.ok(!app.calls.some(c => c.path === '/store/payment-collections'), 'no payment collection for an unsupported country');
  assert.ok(!app.calls.some(c => c.method === 'POST' && c.path === '/store/carts/cart_1'), 'address is not written for an unsupported country');
});

test('a shippable US address still completes the full PayPal sandbox checkout', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [{ id: 'so_1', name: 'Standard Shipping', amount: 9.9 }] } }),
      'POST /store/carts/cart_1/shipping-methods': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9 }) }),
      'POST /store/carts/cart_1': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9 }) }),
      'POST /store/payment-collections': () => ({ status: 200, body: { payment_collection: { id: 'paycol_1' } } }),
      'POST /store/payment-collections/paycol_1/payment-sessions': () => ({
        status: 200,
        body: { payment_collection: { id: 'paycol_1', payment_sessions: [{ id: 'payses_1', provider_id: 'pp_paypal_paypal', data: { approval_url: 'https://www.sandbox.paypal.com/checkoutnow?token=abc' } }] } },
      }),
      'GET /store/regions': regionRoute(US_ONLY),
    },
  });
  await openCheckout(app);
  await app.run("pickShippingOption('so_1')");
  await app.settle();
  app.run(`
    document.getElementById('coEmail').value = 'buyer@example.com';
    document.getElementById('coFirst').value = 'Ada';
    document.getElementById('coLast').value = 'Lovelace';
    document.getElementById('coAddress1').value = '1 Main St';
    document.getElementById('coCity').value = 'San Francisco';
    document.getElementById('coProvince').value = 'CA';
    document.getElementById('coPostal').value = '94107';
    document.getElementById('coCountry').value = 'us';
  `);

  await app.run('placeOrder()');
  await app.settle();

  assert.ok(app.calls.some(c => c.path === '/store/payment-collections'), 'payment collection created');
  assert.equal(app.run('location.href'), 'https://www.sandbox.paypal.com/checkoutnow?token=abc', 'handed off to PayPal');
});

test('an invalid ZIP focuses the field, shows the summary, and never reaches payment', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [{ id: 'so_1', name: 'Standard Shipping', amount: 9.9 }] } }),
      'POST /store/carts/cart_1/shipping-methods': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9 }) }),
      'POST /store/carts/cart_1': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 39.8, shipping_total: 9.9 }) }),
      'POST /store/payment-collections': () => ({ status: 200, body: { payment_collection: { id: 'paycol_1' } } }),
      'POST /store/payment-collections/paycol_1/payment-sessions': () => ({ status: 200, body: { payment_collection: { id: 'paycol_1', payment_sessions: [{ id: 'payses_1', provider_id: 'pp_paypal_paypal', data: { approval_url: 'https://www.sandbox.paypal.com/checkoutnow?token=abc' } }] } } }),
    },
  });
  await app.settle();
  await app.run("addToCart('prod_1')");
  await app.run('checkout()');
  await app.settle();
  await app.run("pickShippingOption('so_1')");
  await app.settle();

  // Fill a valid US address except for an invalid ZIP (101100 is 6 digits).
  app.run(`
    document.getElementById('coEmail').value = 'buyer@example.com';
    document.getElementById('coFirst').value = 'Ada';
    document.getElementById('coLast').value = 'Lovelace';
    document.getElementById('coAddress1').value = '1 Main St';
    document.getElementById('coCity').value = 'New York';
    document.getElementById('coProvince').value = 'NY';
    document.getElementById('coPostal').value = '101100';
    document.getElementById('coCountry').value = 'US';
  `);

  const before = app.calls.length;
  await app.run('placeOrder()');
  await app.settle();

  // No payment collection was created (we never reached the payment step).
  assert.ok(!app.calls.slice(before).some(c => c.path === '/store/payment-collections'),
    'invalid ZIP never starts payment');
  assert.ok(!String(app.run('location.href')).includes('paypal.com'), 'no PayPal handoff on invalid ZIP');

  // The invalid field is focused and its inline error is present.
  assert.equal(app.run("document.getElementById('coPostal').focused"), true, 'the ZIP field is focused');
  const body = app.run("document.getElementById('checkoutBody').innerHTML");
  assert.ok(/Enter a valid ZIP code/.test(body), 'the ZIP error message is shown inline');
  assert.ok(/Please check the highlighted address fields/.test(body), 'the summary message is shown near the button');
});

test('an invalid address field gets a red border that wins the cascade (no grey override)', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/regions': () => ({ status: 200, body: { regions: [{ id: 'reg_1', countries: [{ code: 'us', name: 'United States' }] }] } }),
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'POST /store/carts': () => ({ status: 200, body: cartPayload() }),
      'POST /store/carts/cart_1/line-items': () => ({ status: 200, body: cartPayload({ items: [lineItem()], subtotal: 29.9 }) }),
      'GET /store/shipping-options': () => ({ status: 200, body: { shipping_options: [{ id: 'so_1', name: 'Standard Shipping', amount: 9.9 }] } }),
    },
  });
  await app.settle();
  await app.run("addToCart('prod_1')");
  await app.run('checkout()');
  await app.settle();

  // Flag every address control as invalid and render the form. setFieldError()
  // mutates the live checkoutFieldErrors object the script closes over, so this
  // exercises the same path placeOrder() takes on a failed validation.
  app.run("shippableCountries = [{ code: 'us', name: 'United States' }]; setFieldError('postalCode','x'); setFieldError('province','x'); setFieldError('countryCode','x'); renderCheckout();");

  // The harness's fake DOM does not parse innerHTML, so read the rendered markup.
  const tagFor = (id) => {
    const html = app.run("document.getElementById('checkoutBody').innerHTML");
    const i = html.indexOf(`id="${id}"`);
    return i < 0 ? '' : html.slice(i, html.indexOf('>', i));
  };

  // Regression: the compiled sheet emits .border-slate-200 AFTER .border-red-400,
  // so "border-slate-200 border-red-400" resolves to grey. The error state must
  // carry the error colour EXCLUSIVELY.
  const zipTag = tagFor('coPostal');
  assert.ok(/border-red-400/.test(zipTag), 'invalid ZIP carries border-red-400');
  assert.ok(!/border-slate-200/.test(zipTag), 'invalid ZIP must not also carry the grey border');
  assert.ok(/border-red-400/.test(tagFor('coProvince')), 'invalid state carries border-red-400');
  assert.ok(/border-red-400/.test(tagFor('coCountry')), 'invalid country carries border-red-400');

  // A clean field keeps the neutral border and carries no error colour.
  app.run('resetCheckoutFieldErrors(); renderCheckout();');
  const cleanTag = tagFor('coPostal');
  assert.ok(/border-slate-200/.test(cleanTag), 'clean ZIP keeps border-slate-200');
  assert.ok(!/border-red-400/.test(cleanTag), 'clean ZIP has no error border');
});

test('payment status maps to customer language: authorized is "confirmed", never "not paid"', async () => {
  const app = bootPawShop({
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'GET /store/pawshop-orders/lookup': () => ({ status: 200, body: orderPayload({ payment_status: 'authorized' }) }),
    },
  });
  await app.settle();

  app.run('renderOrderDetail(' + JSON.stringify(orderPayload({ payment_status: 'authorized' }).order) + ')');
  const html = app.nodes.get('orderBody').innerHTML;

  // An authorized (but not yet captured) payment is "confirmed", never "not paid".
  assert.ok(html.includes('Payment confirmed'), 'authorized renders as "Payment confirmed"');
  assert.ok(!html.includes('Not paid'), 'authorized must never render as "Not paid"');
  assert.ok(!html.includes('Payment not completed'), 'authorized must never render as "not completed"');
});

test('payment status maps to Chinese customer language', async () => {
  const app = bootPawShop({
    lang: 'zh',
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
      'GET /store/pawshop-orders/lookup': () => ({ status: 200, body: orderPayload({ payment_status: 'authorized' }) }),
    },
  });
  await app.settle();

  app.run('renderOrderDetail(' + JSON.stringify(orderPayload({ payment_status: 'authorized' }).order) + ')');
  const html = app.nodes.get('orderBody').innerHTML;

  assert.ok(html.includes('支付已确认'), 'authorized renders as 支付已确认 in Chinese');
  assert.ok(!html.includes('未支付'), 'authorized must never render as 未支付 in Chinese');
  assert.ok(html.includes('尚未发货'), 'not_fulfilled renders as 尚未发货 in Chinese');
});

test('a PayPal cancel (no PayerID) shows "payment not completed", never the success page', async () => {
  const app = bootPawShop({
    storage: new Map([
      ['pawshop_order_lookup', JSON.stringify({ email: 'buyer@example.com', cartId: 'cart_1' })],
      ['pawshop_medusa_cart_id', 'cart_1'],
    ]),
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
    },
  });
  await app.settle();

  // PayPal cancels back to the same URL with a token but no PayerID.
  app.run("location.search = '?token=EC-12345'");
  app.run('handlePayPalReturn()');
  await app.settle();

  const html = app.nodes.get('orderBody').innerHTML;
  assert.ok(html.includes('Payment not completed'), 'cancel shows "payment not completed"');
  assert.ok(html.includes('Back to cart'), 'cancel offers a back-to-cart action');
  assert.ok(html.includes('Try again'), 'cancel offers a retry action');
  assert.ok(!html.includes('Payment confirmed'), 'cancel must NEVER show the success confirmation');
  assert.ok(!html.includes('Your order has been created'), 'cancel must NEVER claim the order was created');
  assert.ok(!html.includes('PS-'), 'cancel must NEVER show an order number');

  // The stale return marker is dropped, but the cart id survives so the buyer
  // can retry the same basket.
  assert.equal(app.storage.get('pawshop_order_lookup'), undefined, 'return marker is cleared on cancel');
  assert.equal(app.storage.get('pawshop_medusa_cart_id'), 'cart_1', 'cart id survives cancel for retry');
});

test('a PayPal cancel renders "payment not completed" in Chinese', async () => {
  const app = bootPawShop({
    lang: 'zh',
    storage: new Map([
      ['pawshop_order_lookup', JSON.stringify({ email: 'buyer@example.com', cartId: 'cart_1' })],
    ]),
    routes: {
      'GET /store/products': () => ({ status: 200, body: { products: [product()], count: 1 } }),
    },
  });
  await app.settle();

  app.run("location.search = '?token=EC-12345'");
  app.run('handlePayPalReturn()');
  await app.settle();

  const html = app.nodes.get('orderBody').innerHTML;
  assert.ok(html.includes('支付未完成'), 'cancel shows 支付未完成 in Chinese');
  assert.ok(html.includes('返回购物车'), 'cancel offers 返回购物车 in Chinese');
  assert.ok(html.includes('重试支付'), 'cancel offers 重试支付 in Chinese');
  assert.ok(!html.includes('支付已确认'), 'cancel never shows 支付已确认 in Chinese');
});
