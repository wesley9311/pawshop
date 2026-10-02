import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// Product-content localization contract tests. The storefront resolves
// customer-facing product copy (title/subtitle/description) against
// `product.metadata.i18n`, with three rules: an explicit translation wins,
// otherwise the product's default-locale copy, and an English page never
// receives CJK-only copy (it falls back to '' -> an honest placeholder).
// These tests pin the reading layer (`PawStore.localizedText` /
// `normalizeProduct`) AND the rendering layer (PawShop.html), and guard the
// invariants that must never regress: price/SKU/inventory/handle stay
// single-source, and historical order items are never rewritten by locale.
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// --- fixtures -------------------------------------------------------------

// A product whose default-locale copy is English, with a zh-CN override.
const ENGLISH_PRODUCT = {
  id: 'prod_a',
  title: 'Cardboard Cat Scratcher Bed',
  subtitle: 'Cat Sofa and Lounger for All Seasons',
  description: 'A sturdy lounger.',
  handle: 'corrugated-cat-lounger',
  thumbnail: null,
  images: [{ url: 'https://media.pawlivora.com/a.jpg' }],
  metadata: {
    i18n: {
      default_locale: 'en-US',
      translations: {
        'zh-CN': {
          title: '瓦楞纸猫抓板大床',
          subtitle: '四季通用猫沙发',
          description: '一张结实的躺卧垫。',
        },
      },
    },
  },
  variants: [{
    id: 'variant_a', title: 'Default', sku: 'PAW-CSL-NG-001',
    calculated_price: { calculated_amount: 29.9, currency_code: 'usd' },
    inventory_quantity: 5, manage_inventory: true, allow_backorder: false,
  }],
};

// A product whose default-locale copy is Chinese, with an en-US override.
const CHINESE_PRODUCT = {
  id: 'prod_b',
  title: '红酒瓶猫抓板立式剑麻绳猫抓柱',
  subtitle: null,
  description: null,
  handle: '猫抓板',
  thumbnail: null,
  images: [{ url: 'https://media.pawlivora.com/b.jpg' }],
  metadata: {
    i18n: {
      default_locale: 'zh-CN',
      translations: {
        'en-US': {
          title: 'Red Wine Bottle Cat Scratching Post',
          subtitle: 'Vertical sisal scratching post',
          description: 'A vertical sisal post that does not shed.',
        },
      },
    },
  },
  variants: [{
    id: 'variant_b', title: 'Default', sku: 'PAW-CSL-HJ-001',
    calculated_price: { calculated_amount: 19.9, currency_code: 'usd' },
    inventory_quantity: 3, manage_inventory: true, allow_backorder: false,
  }],
};

// A Chinese product with NO i18n metadata at all (the current production state).
const CHINESE_NO_I18N = {
  ...CHINESE_PRODUCT,
  metadata: null,
};

function productsBody(products) {
  return { status: 200, body: { products, count: products.length } };
}

function makeNode() {
  const classes = new Set();
  const attrs = new Map();
  return {
    innerHTML: '', textContent: '', value: '', style: {}, placeholder: '',
    dataset: {}, focused: false,
    focus() { this.focused = true; },
    scrollIntoView() {},
    setAttribute(k, v) { attrs.set(k, v); },
    classList: {
      add: n => classes.add(n), remove: n => classes.delete(n),
      toggle: n => (classes.has(n) ? classes.delete(n) : classes.add(n)),
      contains: n => classes.has(n),
    },
  };
}

function bootPawShop({ lang = 'en', routes = {}, storage } = {}) {
  const nodes = new Map();
  const calls = [];
  const store = new Map(storage || []);
  if (lang) store.set('pawshop_lang', lang);
  const table = {
    'GET /store/regions': () => ({ status: 200, body: { regions: [{ id: 'reg_1' }] } }),
    'GET /store/products': () => ({ status: 200, body: { products: [], count: 0 } }),
    ...routes,
  };

  const context = vm.createContext({
    URL, URLSearchParams, console,
    location: { origin: 'https://pawlivora.com', href: 'https://pawlivora.com/PawShop.html', search: '' },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
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
      return { ok: result.status < 400, status: result.status, async json() { return result.body; } };
    },
  });
  context.window = context;

  for (const file of ['config.js', 'safe.js', 'store-api.js']) vm.runInContext(read(file), context);
  for (const match of read('PawShop.html').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(match[1], context);
  }

  return {
    context, nodes, calls, storage: store,
    run: code => vm.runInContext(code, context),
    async settle() { for (let i = 0; i < 12; i++) await new Promise(setImmediate); },
  };
}

// --- reading layer: PawStore.localizedText / normalizeProduct ------------

test('localizedText returns an explicit translation for the requested locale', () => {
  const app = bootPawShop();
  assert.equal(
    app.run("PawStore.localizedText(" + JSON.stringify(ENGLISH_PRODUCT) + ", 'zh-CN', 'title')"),
    '瓦楞纸猫抓板大床',
  );
  assert.equal(
    app.run("PawStore.localizedText(" + JSON.stringify(CHINESE_PRODUCT) + ", 'en-US', 'title')"),
    'Red Wine Bottle Cat Scratching Post',
  );
});

test('localizedText falls back to the default-locale field when there is no override', () => {
  const app = bootPawShop();
  // English product, requested zh but no zh override -> English title (acceptable downgrade).
  const zhOnly = { ...ENGLISH_PRODUCT, metadata: { i18n: { default_locale: 'en-US', translations: {} } } };
  assert.equal(app.run("PawStore.localizedText(" + JSON.stringify(zhOnly) + ", 'zh-CN', 'title')"), 'Cardboard Cat Scratcher Bed');
  // Chinese product requested zh (its default locale) -> Chinese title.
  assert.equal(app.run("PawStore.localizedText(" + JSON.stringify(CHINESE_PRODUCT) + ", 'zh-CN', 'title')"), '红酒瓶猫抓板立式剑麻绳猫抓柱');
});

test('localizedText never leaks CJK into an English page (CJK guard)', () => {
  const app = bootPawShop();
  // A Chinese-only product with no en-US override: en must get '', not the Chinese title.
  assert.equal(app.run("PawStore.localizedText(" + JSON.stringify(CHINESE_NO_I18N) + ", 'en-US', 'title')"), '');
  // But zh still gets the Chinese title.
  assert.equal(app.run("PawStore.localizedText(" + JSON.stringify(CHINESE_NO_I18N) + ", 'zh-CN', 'title')"), '红酒瓶猫抓板立式剑麻绳猫抓柱');
});

test('localizedText tolerates missing/null/empty metadata without throwing', () => {
  const app = bootPawShop();
  assert.equal(app.run("PawStore.localizedText(" + JSON.stringify(CHINESE_NO_I18N) + ", 'zh-CN', 'title')"), '红酒瓶猫抓板立式剑麻绳猫抓柱');
  assert.equal(app.run("PawStore.localizedText(" + JSON.stringify({ title: 'Hi', metadata: {} }) + ", 'en-US', 'title')"), 'Hi');
  assert.equal(app.run("PawStore.localizedText(" + JSON.stringify({ title: 'Hi', metadata: { i18n: null } }) + ", 'en-US', 'title')"), 'Hi');
  assert.equal(app.run("PawStore.localizedText(" + JSON.stringify({ title: 'Hi', metadata: { i18n: { translations: null } } }) + ", 'en-US', 'title')"), 'Hi');
});

test('containsCJK detects CJK and rejects ASCII', () => {
  const app = bootPawShop();
  assert.equal(app.run("PawStore.containsCJK('红酒瓶')"), true);
  assert.equal(app.run("PawStore.containsCJK('Cardboard')"), false);
  assert.equal(app.run("PawStore.containsCJK('')"), false);
  assert.equal(app.run("PawStore.containsCJK(null)"), false);
});

test('normalizeProduct resolves copy per locale and keeps price/SKU/inventory/handle single-source', () => {
  const app = bootPawShop();
  const en = app.run("PawStore.normalizeProduct(" + JSON.stringify(ENGLISH_PRODUCT) + ", 'en-US')");
  const zh = app.run("PawStore.normalizeProduct(" + JSON.stringify(ENGLISH_PRODUCT) + ", 'zh-CN')");

  assert.equal(en.title, 'Cardboard Cat Scratcher Bed', 'en bootstrap keeps English title');
  assert.equal(zh.title, '瓦楞纸猫抓板大床', 'zh bootstrap resolves the zh override');

  // Invariants: locale must never touch price, SKU, inventory or handle.
  for (const p of [en, zh]) {
    assert.equal(p.price, 29.9, 'price unchanged across locales');
    assert.equal(p.variants[0].sku, 'PAW-CSL-NG-001', 'SKU unchanged across locales');
    assert.equal(p.variants[0].inventoryQuantity, 5, 'inventory unchanged across locales');
  }
  // i18n is exposed (for client-side re-resolution), but nothing else from metadata.
  assert.ok(zh.i18n && zh.i18n.default_locale === 'en-US', 'i18n sub-key is exposed');
  assert.ok(!('handle' in zh) || zh.handle === undefined, 'handle is not surfaced on the normalized product');
  assert.ok(zh.defaultCopy.title === 'Cardboard Cat Scratcher Bed', 'defaultCopy preserves the source copy');
});

test('normalizeProduct defaults to en-US when an unknown locale is passed', () => {
  const app = bootPawShop();
  const p = app.run("PawStore.normalizeProduct(" + JSON.stringify(ENGLISH_PRODUCT) + ", 'fr-FR')");
  assert.equal(p.title, 'Cardboard Cat Scratcher Bed');
});

// --- rendering layer: PawShop.html ---------------------------------------

test('an English page shows a Chinese-only product as "Details coming soon", never the Chinese title', async () => {
  const app = bootPawShop({
    lang: 'en',
    routes: { 'GET /store/products': () => productsBody([CHINESE_NO_I18N]) },
  });
  await app.settle();

  const grid = app.nodes.get('productGrid').innerHTML;
  assert.ok(grid.includes('Details coming soon'), 'en page shows the honest placeholder');
  assert.ok(!grid.includes('红酒瓶'), 'the Chinese title must never appear on an English page');
});

test('a Chinese page shows a Chinese product directly (its default locale)', async () => {
  const app = bootPawShop({
    lang: 'zh',
    routes: { 'GET /store/products': () => productsBody([CHINESE_NO_I18N]) },
  });
  await app.settle();

  const grid = app.nodes.get('productGrid').innerHTML;
  assert.ok(grid.includes('红酒瓶猫抓板立式剑麻绳猫抓柱'), 'zh page shows the Chinese title');
});

test('an English product with a zh override renders Chinese on a zh page', async () => {
  const app = bootPawShop({
    lang: 'zh',
    routes: { 'GET /store/products': () => productsBody([ENGLISH_PRODUCT]) },
  });
  await app.settle();

  const grid = app.nodes.get('productGrid').innerHTML;
  assert.ok(grid.includes('瓦楞纸猫抓板大床'), 'zh page shows the zh override title');
  assert.ok(!grid.includes('Cardboard Cat Scratcher Bed'), 'the English title is not shown on a zh page when a zh override exists');
});

test('a language switch re-renders the catalog, modal and cart copy without a refetch', async () => {
  const app = bootPawShop({
    lang: 'en',
    routes: { 'GET /store/products': () => productsBody([ENGLISH_PRODUCT, CHINESE_PRODUCT]) },
  });
  await app.settle();

  // Open the English product modal, then switch to zh.
  app.run("openProduct('prod_a')");
  app.run("setLang('zh')");
  const modal = app.nodes.get('productModalBody').innerHTML;
  assert.ok(modal.includes('瓦楞纸猫抓板大床'), 'modal re-resolves to zh title');
  assert.ok(modal.includes('四季通用猫沙发'), 'modal re-resolves to zh subtitle');

  // The catalog grid also re-resolved.
  const grid = app.nodes.get('productGrid').innerHTML;
  assert.ok(grid.includes('瓦楞纸猫抓板大床'), 'grid re-resolves to zh');
  // Product B's default locale is zh-CN, so on a zh page it shows its Chinese
  // default title (no en-US override applies); switching to en would show its
  // en-US override instead.
  assert.ok(grid.includes('红酒瓶猫抓板立式剑麻绳猫抓柱'), 'the Chinese-default product shows its Chinese title on a zh page');
});

test('a Chinese-only product switches to English and back without leaking CJK', async () => {
  const app = bootPawShop({
    lang: 'zh',
    routes: { 'GET /store/products': () => productsBody([CHINESE_NO_I18N]) },
  });
  await app.settle();
  assert.ok(app.nodes.get('productGrid').innerHTML.includes('红酒瓶'), 'zh shows Chinese');

  app.run("setLang('en')");
  const enGrid = app.nodes.get('productGrid').innerHTML;
  assert.ok(enGrid.includes('Details coming soon'), 'en shows placeholder');
  assert.ok(!enGrid.includes('红酒瓶'), 'en never shows Chinese');

  app.run("setLang('zh')");
  assert.ok(app.nodes.get('productGrid').innerHTML.includes('红酒瓶'), 'switching back to zh restores Chinese');
});

test('cart line items localize their title via the loaded product catalog', async () => {
  const app = bootPawShop({
    lang: 'en',
    routes: {
      'GET /store/products': () => productsBody([ENGLISH_PRODUCT]),
      'GET /store/carts/cart_1': () => ({
        status: 200,
        body: {
          cart: {
            id: 'cart_1', currency_code: 'usd', region_id: 'reg_1',
            subtotal: 29.9, item_subtotal: 29.9, shipping_total: 0, total: 29.9,
            items: [{
              id: 'li_1', product_title: 'Cardboard Cat Scratcher Bed',
              variant_id: 'variant_a', variant_title: 'Default',
              variant_sku: 'PAW-CSL-NG-001', thumbnail: null,
              quantity: 1, unit_price: 29.9,
            }],
          },
        },
      }),
    },
    storage: new Map([['pawshop_medusa_cart_id', 'cart_1']]),
  });
  await app.settle();

  // Switch to zh: the cart title should re-resolve from the loaded product.
  app.run("setLang('zh')");
  const drawer = app.nodes.get('cartItems').innerHTML;
  assert.ok(drawer.includes('瓦楞纸猫抓板大床'), 'cart title localizes to zh via variant id');
});

test('the cart never localizes a line item it cannot map to a product (server title kept)', async () => {
  const app = bootPawShop({
    lang: 'zh',
    routes: {
      'GET /store/products': () => productsBody([ENGLISH_PRODUCT]),
      'GET /store/carts/cart_1': () => ({
        status: 200,
        body: {
          cart: {
            id: 'cart_1', currency_code: 'usd', region_id: 'reg_1',
            subtotal: 29.9, item_subtotal: 29.9, shipping_total: 0, total: 29.9,
            items: [{ id: 'li_1', product_title: 'Cardboard Cat Scratcher Bed', quantity: 1, unit_price: 29.9 }],
          },
        },
      }),
    },
    storage: new Map([['pawshop_medusa_cart_id', 'cart_1']]),
  });
  await app.settle();

  const drawer = app.nodes.get('cartItems').innerHTML;
  assert.ok(drawer.includes('Cardboard Cat Scratcher Bed'), 'unmapped item keeps its server title');
});

test('historical order items are never rewritten by the current locale', async () => {
  // Order items come from the lookup payload with their own `title`; the page
  // must render them verbatim and must not route them through product-copy
  // localization (an order is an immutable record).
  const app = bootPawShop({
    lang: 'en',
    routes: {
      'GET /store/products': () => productsBody([CHINESE_PRODUCT]),
      'GET /store/pawshop-orders/lookup': () => ({
        status: 200,
        body: {
          order: {
            order_number: 1001, public_order_number: 'PS-20260928-1001',
            status: 'completed', payment_status: 'captured', fulfillment_status: 'not_fulfilled',
            currency_code: 'usd', total: 29.9, created_at: '2026-09-28T12:00:00.000Z',
            email: 'buyer@example.com',
            items: [{ title: '红酒瓶猫抓板立式剑麻绳猫抓柱', quantity: 1, unit_price: 29.9, total: 29.9, thumbnail: null }],
            shipping_method: 'Standard Shipping', shipping_amount: 0, shipping_address: null,
          },
        },
      }),
    },
  });
  await app.settle();

  app.run('renderOrderDetail(' + JSON.stringify({
    order_number: 1001, public_order_number: 'PS-20260928-1001', status: 'completed',
    payment_status: 'captured', fulfillment_status: 'not_fulfilled', currency_code: 'usd',
    total: 29.9, created_at: '2026-09-28T12:00:00.000Z', email: 'buyer@example.com',
    items: [{ title: '红酒瓶猫抓板立式剑麻绳猫抓柱', quantity: 1, unit_price: 29.9, total: 29.9, thumbnail: null }],
    shipping_method: 'Standard Shipping', shipping_amount: 0, shipping_address: null,
  }) + ')');

  const html = app.nodes.get('orderBody').innerHTML;
  // The order record is shown verbatim — the product's en-US override ("Red Wine
  // Bottle...") must NOT replace the historical item title.
  assert.ok(html.includes('红酒瓶猫抓板立式剑麻绳猫抓柱'), 'order item title is preserved verbatim');
  assert.ok(!html.includes('Red Wine Bottle'), 'order items are not re-localized to the current page language');
});

test('the product copy placeholder is itself bilingual', () => {
  const en = bootPawShop({ lang: 'en' });
  assert.equal(en.run("t('product_copy_pending')"), 'Details coming soon');
  const zh = bootPawShop({ lang: 'zh' });
  assert.equal(zh.run("t('product_copy_pending')"), '详情即将上线');
});

test('the storefront requests the metadata field so i18n can resolve', async () => {
  const app = bootPawShop({ routes: { 'GET /store/products': () => productsBody([ENGLISH_PRODUCT]) } });
  await app.settle();
  const call = app.calls.find(c => c.path === '/store/products');
  assert.ok(call, 'a products request was made');
  assert.ok(call.url.includes('fields='), 'the request carries explicit fields');
  assert.ok(decodeURIComponent(call.url).includes('metadata'), 'metadata is requested');
});
