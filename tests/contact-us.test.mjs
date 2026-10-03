import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// CONTACT US / CUSTOMER SUPPORT ENTRY — Phase 1 contract tests.
//
// The storefront surfaces a single support inbox (config.supportEmail, the same
// mailbox the transactional emails use) through two entry points: a footer
// "Contact us" link, and an order-detail "Need help with this order?" mailto
// that carries the *public* order number (PS-YYYYMMDD-NNNN) into the subject
// and body. The tests pin the invariants: en/zh copy, both entry points, the
// order number carried correctly, no internal id, no PII auto-filled, and a
// missing/empty order number never producing an invalid contact context.
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

const SUPPORT_EMAIL = '504533680@qq.com';

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
      add: n => classes.add(n), remove: n => classes.delete(n),
      toggle: n => (classes.has(n) ? classes.delete(n) : classes.add(n)),
      contains: n => classes.has(n),
    },
  };
}

function bootPawShop({ lang = 'en', routes = {}, storage, supportEmail } = {}) {
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
    URL, URLSearchParams, console, encodeURIComponent, decodeURIComponent,
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

  let configSource = read('config.js');
  // Let callers exercise the "no support inbox" path by rewriting the public
  // config's supportEmail before it is frozen. Only the address is touched.
  if (supportEmail === '') {
    configSource = configSource.replace(/supportEmail:\s*'[^']*'/, "supportEmail: ''");
  }
  vm.runInContext(configSource, context);
  for (const file of ['safe.js', 'store-api.js']) vm.runInContext(read(file), context);
  for (const match of read('PawShop.html').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(match[1], context);
  }

  return {
    context, nodes, calls, storage: store,
    run: code => vm.runInContext(code, context),
    async settle() { for (let i = 0; i < 12; i++) await new Promise(setImmediate); },
  };
}

// A realistic order as returned by the guest lookup.
function orderFixture(overrides = {}) {
  return {
    order_number: 6,
    public_order_number: 'PS-20260929-0006',
    status: 'completed',
    payment_status: 'captured',
    fulfillment_status: 'not_fulfilled',
    currency_code: 'usd',
    total: 29.9,
    created_at: '2026-09-29T12:00:00.000Z',
    email: 'buyer@example.com',
    items: [{ title: 'Cardboard Cat Scratcher Bed', quantity: 1, unit_price: 29.9, total: 29.9, thumbnail: null }],
    shipping_method: 'Standard Shipping',
    shipping_amount: 0,
    shipping_address: { first_name: 'Jane', last_name: 'Doe', address_1: '1 Main St', city: 'NYC', province: 'NY', postal_code: '10001', country_code: 'us' },
    fulfillments: [],
    ...overrides,
  };
}

// --- config source -------------------------------------------------------

test('support email comes from the single public config, matching the transactional mailbox', () => {
  const app = bootPawShop();
  assert.equal(app.run('supportEmail'), SUPPORT_EMAIL, 'storefront reuses the transactional support address');
  assert.equal(app.run('CONFIG.supportEmail'), SUPPORT_EMAIL, 'the value is the public config field');
});

// --- footer entry --------------------------------------------------------

test('footer "Contact us" is a mailto: to the support inbox with no order context', async () => {
  const app = bootPawShop({ lang: 'en' });
  await app.settle();
  const href = app.nodes.get('footerContactLink').getAttribute('href') || '';
  assert.ok(href.startsWith('mailto:' + SUPPORT_EMAIL), 'footer link targets the support inbox');
  assert.ok(!href.includes('PS-'), 'footer contact carries no order number');
  assert.ok(!href.includes('subject=') || !decodeURIComponent(href).includes('order'), 'no order subject in the footer contact');
});

test('footer "Contact us" label localizes (en/zh)', async () => {
  const en = bootPawShop({ lang: 'en' });
  await en.settle();
  const zh = bootPawShop({ lang: 'zh' });
  await zh.settle();
  assert.equal(en.run("t('footer_contact')"), 'Contact us');
  assert.equal(zh.run("t('footer_contact')"), '联系我们');
});

// --- order detail entry --------------------------------------------------

test('order detail shows "Need help" and the mailto carries the public order number in subject', async () => {
  const app = bootPawShop({ lang: 'en' });
  await app.settle();
  app.run('renderOrderDetail(' + JSON.stringify(orderFixture()) + ')');
  const html = app.nodes.get('orderBody').innerHTML;
  assert.ok(html.includes('Need help with this order?'), 'order detail shows the help prompt');
  assert.ok(html.includes('PS-20260929-0006'), 'the public order number is shown');

  // Extract the mailto href and decode it to assert subject carries the order.
  const href = app.run('contactMailtoHref("PS-20260929-0006")');
  assert.ok(href.startsWith('mailto:' + SUPPORT_EMAIL), 'mailto targets the support inbox');
  const decoded = decodeURIComponent(href);
  assert.ok(decoded.includes('Question about order PS-20260929-0006'), 'subject carries the public order number');
});

test('order detail mailto never exposes the internal order id and never auto-fills PII', async () => {
  const app = bootPawShop({ lang: 'en' });
  await app.settle();
  app.run('renderOrderDetail(' + JSON.stringify(orderFixture()) + ')');
  const html = app.nodes.get('orderBody').innerHTML;

  // The internal id (order_number=6 as a bare display id is NOT the Medusa pk,
  // but the public number is what the copy must use) must not leak: the mailto
  // body/subject only ever carries "PS-...", never a bare "6" as order context.
  const href = app.run('contactMailtoHref("PS-20260929-0006")');
  const decoded = decodeURIComponent(href);
  assert.ok(!decoded.includes('buyer@example.com'), 'customer email is never auto-filled');
  assert.ok(!decoded.includes('Jane Doe'), 'customer name is never auto-filled');
  assert.ok(!decoded.includes('1 Main St'), 'customer address is never auto-filled');
  // The public order number is the only order identifier present.
  assert.ok(decoded.includes('PS-20260929-0006'), 'public order number present');
  assert.ok(!/order_number=6|display_id/.test(decoded), 'internal id form is not emitted');
});

test('the order-help prompt and subject localize (en/zh)', async () => {
  const en = bootPawShop({ lang: 'en' });
  await en.settle();
  en.run('renderOrderDetail(' + JSON.stringify(orderFixture()) + ')');
  assert.ok(en.nodes.get('orderBody').innerHTML.includes('Need help with this order?'));
  assert.ok(decodeURIComponent(en.run('contactMailtoHref("PS-20260929-0006")')).includes('Question about order PS-20260929-0006'));

  const zh = bootPawShop({ lang: 'zh' });
  await zh.settle();
  zh.run('renderOrderDetail(' + JSON.stringify(orderFixture()) + ')');
  assert.ok(zh.nodes.get('orderBody').innerHTML.includes('此订单需要帮助？'));
  assert.ok(decodeURIComponent(zh.run('contactMailtoHref("PS-20260929-0006")')).includes('关于订单 PS-20260929-0006 的咨询'));
});

// --- invalid / empty order state -----------------------------------------

test('an order with no public number never produces an order-scoped contact context', () => {
  const app = bootPawShop({ lang: 'en' });
  // contactMailtoHref('') → a plain footer-style mailto with no order number.
  const href = app.run('contactMailtoHref("")');
  assert.ok(href.startsWith('mailto:' + SUPPORT_EMAIL), 'still a valid support mailto');
  assert.ok(!decodeURIComponent(href).includes('PS-'), 'no order number in an empty-context contact');
});

test('the order-help block is omitted entirely when no support email is configured', async () => {
  // Boot with supportEmail stripped from the public config; the storefront must
  // then omit the order-help block and fall back to a context-free footer link.
  const app = bootPawShop({ lang: 'en', supportEmail: '' });
  await app.settle();
  app.run('renderOrderDetail(' + JSON.stringify(orderFixture()) + ')');
  const html = app.nodes.get('orderBody').innerHTML;
  assert.ok(!html.includes('Need help with this order?'), 'help block hidden when no support email');
  assert.equal(app.run('contactMailtoHref("PS-20260929-0006")'), '', 'no mailto produced without a support inbox');
});

test('the i18n tables carry the same contact/help keys in en and zh', () => {
  const app = bootPawShop();
  const en = app.run('Object.keys(I18N.en)');
  const zh = app.run('Object.keys(I18N.zh)');
  for (const key of ['footer_contact', 'order_need_help', 'order_contact_us', 'contact_subject', 'contact_body_intro', 'contact_body_blank']) {
    assert.ok(en.includes(key), `en has ${key}`);
    assert.ok(zh.includes(key), `zh has ${key}`);
  }
});
