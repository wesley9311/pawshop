'use strict';

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { createReadStream, readFileSync } = require('node:fs');
const { resolve, sep } = require('node:path');

const criticalTables = [
  ['product', 'id'],
  ['product_variant', 'id'],
  ['product_variant_price_set', 'variant_id, price_set_id'],
  ['price', 'id'],
  ['image', 'id'],
  ['customer', 'id'],
  ['"order"', 'id'],
  ['"user"', 'id'],
];

function criticalDataSha256(query) {
  const hash = createHash('sha256');
  for (const [table, order] of criticalTables) {
    const rows = query(`SELECT row_to_json(t)::text FROM (SELECT * FROM ${table} ORDER BY ${order}) t;`);
    hash.update(table).update('\0').update(rows).update('\0');
  }
  return hash.digest('hex');
}

function readBackupKey(keyFile) {
  const encoded = readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(encoded)) throw new Error('PawShop backup key has an invalid format.');
  return Buffer.from(encoded, 'hex');
}

function digestFile(file, { hmacKey } = {}) {
  return new Promise((resolveDigest, reject) => {
    const digest = hmacKey ? createHmac('sha256', hmacKey) : createHash('sha256');
    const input = createReadStream(file);
    input.on('data', (chunk) => digest.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolveDigest(digest.digest('hex')));
  });
}

function equalHex(left, right) {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function constrainedBackupPath(backupDir, candidate, label) {
  const base = resolve(backupDir);
  const target = resolve(candidate);
  if (!target.startsWith(`${base}${sep}`)) throw new Error(`${label} must remain inside the private backup directory.`);
  return target;
}

module.exports = {
  constrainedBackupPath,
  criticalDataSha256,
  digestFile,
  equalHex,
  readBackupKey,
};
