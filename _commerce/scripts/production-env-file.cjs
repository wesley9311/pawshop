'use strict';

const requiredFields = [
  'ADMIN_ORIGIN', 'COOKIE_SECRET', 'DATABASE_URL', 'JWT_SECRET', 'MEDUSA_WORKER_MODE',
  'NODE_ENV', 'PAWSHOP_INFRA_TOPOLOGY', 'PAWSHOP_MIGRATIONS_CONFIRMED', 'PAWSHOP_MODE',
  'PORT', 'REDIS_URL', 'S3_ACCESS_KEY_ID', 'S3_BUCKET', 'S3_DISABLE_ACL',
  'S3_ENDPOINT', 'S3_FILE_URL', 'S3_FORCE_PATH_STYLE', 'S3_REGION', 'S3_SECRET_ACCESS_KEY',
  'STOREFRONT_ORIGIN',
].sort();

function parseProductionEnvironmentFile(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 64 * 1024 || source.includes('\0')) {
    throw new Error('Production environment file has an unsafe format.');
  }
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    if (rawLine === '' || rawLine.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\r\n]+)$/.exec(rawLine);
    if (!match || match[2] !== match[2].trim() || /[\\'"\s]/.test(match[2]) || Object.hasOwn(values, match[1])) {
      throw new Error('Production environment file contains an invalid or duplicate entry.');
    }
    values[match[1]] = match[2];
  }
  if (Object.keys(values).sort().join('\0') !== requiredFields.join('\0')) {
    throw new Error('Production environment file fields do not match the approved contract.');
  }
  if (values.PAWSHOP_INFRA_TOPOLOGY !== 'single-host-private') {
    throw new Error('This production environment contract supports only the single-host-private topology.');
  }
  return values;
}

function assertProductionEnvironmentFileStat(stat, serviceGid) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== serviceGid || (stat.mode & 0o777) !== 0o640) {
    throw new Error('Production environment file must be root-owned, nonsymlink, service-group, and mode 0640.');
  }
}

module.exports = { assertProductionEnvironmentFileStat, parseProductionEnvironmentFile, requiredFields };
