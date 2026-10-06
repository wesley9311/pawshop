import { readFile } from 'node:fs/promises';

// Pages published by ops/deploy-static.sh (public_paths). Keep this list in
// sync with that manifest: these are the HTML files that reach the production
// origin.
const deployedPages = [
  'index.html',
  'PawShop.html',
  'product.html',
  'shipping.html',
  'returns.html',
  'privacy.html',
  'terms.html',
];

// Retired pages. They are deliberately excluded from the production release
// (they must return 404 there) but they are still tracked, so they are scanned
// as well: the GitHub Pages mirror of this repository serves them publicly.
const legacyPages = ['account.html', 'admin.html', 'dashboard.html'];

const allPages = [...deployedPages, ...legacyPages];
const publicFiles = [...allPages, 'config.js', 'support.js', 'safe.js', 'store-api.js'];

const forbidden = [
  ['published demo password', /pawshop2026/i],
  ['browser GitHub token', /pawshop_github_token|github_pat_/i],
  ['browser AI secret', /pawshop_glm_key/i],
  ['browser image-host secret', /pawshop_imgbb_key/i],
  ['fake order success', /Order placed!|订单已提交|ORDER SAVED/i],
  ['client-side payment choice', /name=["']payment["']|PayPal balance or card|Visa \/ Mastercard \/ Amex/i],
  // Checkout is real now. The storefront may create a payment collection and
  // a payment session (to hand the buyer off to PayPal) but it must NEVER
  // complete a cart itself — the order is created only by the provider's
  // webhook (authorized → complete-cart workflow), which is the guarantee that
  // the page cannot fabricate an order or mark a payment successful on its own.
  ['storefront completes a cart', /\/complete\b|completeCart/i],
  // Customer login (/auth/customer/emailpass) is now a legitimate storefront
  // feature (Account Experience Phase 1): the shopper signs in with their OWN
  // email + password to see their own orders. What must never appear on the
  // storefront is the ADMIN login namespace (/auth/user/) or any admin/service
  // credential — those are a completely different trust boundary.
  ['storefront exposes admin auth', /\/auth\/user\//i],
  // The system provider takes money-less "authorized" payments and would let an
  // order complete without real payment. It must never be referenced on the
  // storefront (or exposed to a customer-facing region).
  ['system payment provider leaked', /pp_system|pp_system_default/],
];

const failures = [];
for (const file of publicFiles) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) failures.push(`${file}: ${label}`);
  }
}

for (const file of ['PawShop.html', 'product.html']) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  if (!source.includes('Content-Security-Policy')) failures.push(`${file}: missing content security policy`);
}

if (failures.length) {
  console.error('Security regression check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Security regression check passed.');

const catalog = JSON.parse(await readFile(new URL('../catalog.json', import.meta.url), 'utf8'));
const privateCatalogFields = ['costCNY', 'supplier', 'supplierLink', 'paymentLink'];
for (const product of catalog) {
  if (product.active === false) failures.push(`catalog.json: inactive product ${product.id} is publicly downloadable`);
  if (product.availability !== 'prelaunch') failures.push(`catalog.json: product ${product.id} does not use the prelaunch availability gate`);
  if (Object.hasOwn(product, 'stock')) failures.push(`catalog.json: product ${product.id} exposes unverified stock`);
  if (Object.hasOwn(product, 'originalPrice')) failures.push(`catalog.json: product ${product.id} exposes an unverified reference price`);
  for (const field of privateCatalogFields) {
    if (Object.hasOwn(product, field)) failures.push(`catalog.json: private field ${field}`);
  }
}

if (failures.length) {
  console.error('Public catalog boundary check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Public catalog boundary check passed.');
