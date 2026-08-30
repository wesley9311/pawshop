import { readFile } from 'node:fs/promises';

const publicFiles = ['PawShop.html', 'product.html', 'account.html', 'admin.html', 'dashboard.html', 'config.js', 'support.js'];
const forbidden = [
  ['published demo password', /pawshop2026/i],
  ['browser GitHub token', /pawshop_github_token|github_pat_/i],
  ['browser AI secret', /pawshop_glm_key/i],
  ['browser image-host secret', /pawshop_imgbb_key/i],
  ['fake order success', /Order placed!|订单已提交|ORDER SAVED/i],
  ['client-side payment choice', /name=["']payment["']|PayPal balance or card|Visa \/ Mastercard \/ Amex/i]
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
