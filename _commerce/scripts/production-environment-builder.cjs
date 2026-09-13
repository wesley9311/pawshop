'use strict';

const { parseProductionEnvironmentFile, requiredFields } = require('./production-env-file.cjs');
const { validateProductionEnvironment } = require('../src/lib/production-policy.cjs');

const internalFields = ['COOKIE_SECRET', 'DATABASE_URL', 'JWT_SECRET', 'REDIS_URL'].sort();

function parsePrivateKeyValueFile(source, expectedFields) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 16 * 1024 || source.includes('\0')) {
    throw new Error('Private production input has an unsafe format.');
  }
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    if (rawLine === '') continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\r\n]+)$/.exec(rawLine);
    if (!match || match[2] !== match[2].trim() || /[\\'"\s]/.test(match[2]) || Object.hasOwn(values, match[1])) {
      throw new Error('Private production input contains an invalid or duplicate entry.');
    }
    values[match[1]] = match[2];
  }
  if (Object.keys(values).sort().join('\0') !== expectedFields.join('\0')) {
    throw new Error('Private production input fields do not match the approved contract.');
  }
  return values;
}

function parseSingleSecret(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 1024 || source.includes('\0')) {
    throw new Error('Object-storage credential input has an unsafe format.');
  }
  const value = source.endsWith('\n') ? source.slice(0, -1) : source;
  if (!value || /[\r\n\\'"\s]/.test(value)) {
    throw new Error('Object-storage credential input must contain exactly one safe line.');
  }
  return value;
}

function buildProductionEnvironment({ internalSource, accessKeySource, secretKeySource }) {
  const internal = parsePrivateKeyValueFile(internalSource, internalFields);
  const values = {
    ADMIN_ORIGIN: 'http://127.0.0.1:9000',
    ...internal,
    MEDUSA_WORKER_MODE: 'shared',
    NODE_ENV: 'production',
    PAWSHOP_INFRA_TOPOLOGY: 'single-host-private',
    PAWSHOP_MIGRATIONS_CONFIRMED: '0',
    PAWSHOP_MODE: 'production-admin-only',
    PORT: '9000',
    S3_ACCESS_KEY_ID: parseSingleSecret(accessKeySource),
    S3_BUCKET: 'pawlivora-products-us-west-1',
    S3_DISABLE_ACL: '1',
    S3_ENDPOINT: 'https://oss-us-west-1.aliyuncs.com',
    S3_FILE_URL: 'https://pawlivora-products-us-west-1.oss-us-west-1.aliyuncs.com',
    S3_FORCE_PATH_STYLE: '0',
    S3_REGION: 'oss-us-west-1',
    S3_SECRET_ACCESS_KEY: parseSingleSecret(secretKeySource),
    STOREFRONT_ORIGIN: 'https://pawlivora.com',
  };
  const source = `${requiredFields.map(field => `${field}=${values[field]}`).join('\n')}\n`;
  const parsed = parseProductionEnvironmentFile(source);
  validateProductionEnvironment(parsed);
  return source;
}

module.exports = { buildProductionEnvironment, internalFields, parsePrivateKeyValueFile, parseSingleSecret };
