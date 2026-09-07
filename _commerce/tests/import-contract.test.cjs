'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..', '..');
const importer = readFileSync(resolve(root, '_commerce/src/scripts/import-catalog.ts'), 'utf8');
const pagesConfig = readFileSync(resolve(root, '_config.yml'), 'utf8');

test('catalog importer preserves approved commercial review gates', () => {
  assert.match(importer, /status:\s*ProductStatus\.DRAFT/);
  assert.match(importer, /reviewed_for_sale:\s*false/);
  assert.match(importer, /product\.price !== 29\.9/);
  assert.match(importer, /product\.images\.length !== 9/);
  assert.match(importer, /product\.availability !== 'prelaunch'/);
  assert.match(importer, /Object\.prototype\.hasOwnProperty\.call\(product, 'stock'\)/);
  assert.match(importer, /assets\\\/products\\\/cat-lounger/);
  assert.match(importer, /PUBLIC_ORIGIN = 'https:\/\/pawlivora\.com'/);
  assert.doesNotMatch(importer, /amount:\s*source\.price\s*\*\s*100/);
});

test('GitHub Pages excludes the entire commerce runtime', () => {
  assert.match(pagesConfig, /^\s*- _commerce\s*$/m);
});
