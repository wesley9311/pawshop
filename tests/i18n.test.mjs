import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// The storefront ships one bilingual UI table (en + zh). These tests pin the
// structural guarantees that keep it correct: the two languages carry the same
// keys (no half-translated surface), every key the page references actually
// exists, the language choice survives a refresh, and a language switch
// re-renders whatever is on screen without leaking a raw i18n key or a
// mixed-language hardcoded string.
const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

function boot(lang = 'en', { routes = {} } = {}) {
  const source = read('PawShop.html');
  const nodes = new Map();
  const calls = [];
  const store = new Map();
  if (lang) store.set('pawshop_lang', lang);
  const table = {
    'GET /store/regions': () => ({ status: 200, body: { regions: [{ id: 'reg_1' }] } }),
    'GET /store/products': () => ({ status: 200, body: { products: [], count: 0 } }),
    ...routes,
  };

  function makeNode() {
    const classes = new Set();
    const attrs = new Map();
    return {
      innerHTML: '', textContent: '', value: '', style: {}, placeholder: '',
      dataset: {},
      focused: false,
      focus() { this.focused = true; },
      scrollIntoView() {},
      setAttribute(k, v) { attrs.set(k, v); },
      classList: {
        add: n => classes.add(n),
        remove: n => classes.delete(n),
        toggle: n => (classes.has(n) ? classes.delete(n) : classes.add(n)),
        contains: n => classes.has(n),
      },
    };
  }

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
  for (const match of source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);

  return {
    context, nodes, calls, storage: store, source,
    run: code => vm.runInContext(code, context),
    async settle() { for (let i = 0; i < 12; i++) await new Promise(setImmediate); },
  };
}

// Extract the I18N table from the page source and evaluate it, so the test can
// assert on the real keys without a hand-maintained mirror that would drift.
function i18nTable() {
  const source = read('PawShop.html');
  const start = source.indexOf('const I18N = {');
  const end = source.indexOf('\n};\n', start);
  const block = source.slice(start, end);
  const extract = (lang) => {
    const marker = `${lang}: {`;
    const idx = block.indexOf(marker);
    let depth = 0;
    let i = idx + marker.length - 1;
    for (; i < block.length; i += 1) {
      if (block[i] === '{') depth += 1;
      else if (block[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const body = block.slice(idx + marker.length, i);
    return new Function(`return {${body}};`)();
  };
  return { en: extract('en'), zh: extract('zh'), source };
}

test('the zh and en tables carry exactly the same keys', () => {
  const { en, zh } = i18nTable();
  const enKeys = Object.keys(en).sort();
  const zhKeys = Object.keys(zh).sort();
  const onlyEn = enKeys.filter(k => !(k in zh));
  const onlyZh = zhKeys.filter(k => !(k in en));
  assert.deepEqual(onlyEn, [], 'every en key must have a zh counterpart');
  assert.deepEqual(onlyZh, [], 'every zh key must have an en counterpart');
  assert.ok(enKeys.length > 100, 'the table is non-trivial');
});

test('every key the page references exists in the table', () => {
  const { en, source } = i18nTable();
  const used = new Set();
  for (const m of source.matchAll(/\bt\(\s*["']([a-z0-9_]+)["']\s*\)/g)) used.add(m[1]);
  for (const m of source.matchAll(/data-i18n(?:-ph|-a11y|-title)?="([a-z0-9_]+)"/g)) used.add(m[1]);
  const missing = [...used].filter(k => !(k in en)).sort();
  assert.deepEqual(missing, [], 'no referenced key may be missing from the table');
});

test('the language choice survives a reload', () => {
  const app = boot('zh');
  assert.equal(app.storage.get('pawshop_lang'), 'zh');
  assert.equal(app.run('lang'), 'zh');
  // A fresh boot seeded with the stored language reads zh again.
  const again = boot('zh');
  assert.equal(again.run('lang'), 'zh');
});

test('switching to English and back persists and re-renders product copy', async () => {
  const app = boot('en');
  await app.settle();
  app.run("setLang('zh')");
  assert.equal(app.run('lang'), 'zh');
  assert.equal(app.storage.get('pawshop_lang'), 'zh');
  const grid = app.nodes.get('productGrid').innerHTML;
  assert.ok(grid.includes('暂无可购买商品'), 'zh switch re-renders product copy');
  assert.ok(!grid.includes('No products available'), 'no English residue after switching to zh');

  app.run("setLang('en')");
  assert.equal(app.run('lang'), 'en');
  assert.ok(app.nodes.get('productGrid').innerHTML.includes('No products available'), 'en switch re-renders');
});

test('no raw i18n key or mixed-language hardcode leaks into rendered UI', async () => {
  // The zh surface must not contain an English hardcoded label that should have
  // been translated, and must never show a raw key (e.g. "co_email_required").
  const app = boot('zh');
  await app.settle();
  const grid = app.nodes.get('productGrid').innerHTML;
  assert.ok(!/co_email_required|order_lookup_title|nav_shop/.test(grid), 'no raw i18n key in rendered markup');
  // The footer and chrome labels are data-i18n driven; assert the keys exist.
  const { en } = i18nTable();
  for (const k of ['footer_privacy', 'footer_terms', 'footer_copyright', 'a11y_cart', 'a11y_close', 'lookup_number_ph']) {
    assert.ok(k in en, `chrome key ${k} must exist`);
  }
});

test('the lookup placeholders are bilingual (not a hardcoded 1001/you@example.com)', async () => {
  const app = boot('zh');
  await app.settle();
  app.run('renderOrderLookupForm()');
  const html = app.nodes.get('orderBody').innerHTML;
  assert.ok(html.includes('例如 1001'), 'zh lookup number placeholder is translated');
  assert.ok(!html.includes('placeholder="1001"'), 'no hardcoded English number placeholder');

  const enApp = boot('en');
  await enApp.settle();
  enApp.run('renderOrderLookupForm()');
  const enHtml = enApp.nodes.get('orderBody').innerHTML;
  assert.ok(enHtml.includes('e.g. 1001'), 'en lookup number placeholder');
  assert.ok(enHtml.includes('you@example.com'), 'en lookup email placeholder');
});

test('a language switch re-renders an open checkout without losing the draft', async () => {
  const app = boot('en');
  await app.settle();
  // Open the checkout modal and render its form, then type an email into the draft.
  app.run("document.getElementById('checkoutModal').classList.add('open')");
  app.run('renderCheckout()');
  app.run("setDraft('email', 'buyer@example.com')");
  app.run("setLang('zh')");
  assert.equal(app.run('checkoutDraft.email'), 'buyer@example.com', 'draft survives a language switch');
  const html = app.nodes.get('checkoutBody').innerHTML;
  assert.ok(html.includes('收货地址'), 'checkout re-renders in zh');
  assert.ok(html.includes('确认并支付'), 'checkout button re-renders in zh');
});
