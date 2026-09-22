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
  // Checkout is not connected yet. A storefront must not be able to complete a
  // cart, open a payment session, or pick a payment provider on its own. The
  // checkout form may write email/address/shipping back to the cart and stop at
  // the payment boundary, but it must never call the completion endpoint.
  ['storefront completes a cart', /\/complete\b|completeCart/i],
  ['storefront touches payment sessions', /payment[-_]?sessions?|payment[-_]?collection/i],
  ['storefront sends customer credentials', /emailpass|customer\/register|\/auth\/customer/i]
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
