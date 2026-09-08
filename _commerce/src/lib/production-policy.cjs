'use strict';

function explicitOrigin(env, field, { allowLoopbackHttp = false } = {}) {
  const value = env[field] || '';
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field} must be an explicit allowed origin.`); }
  const loopbackHttp = allowLoopbackHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!loopbackHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${field} must be an explicit allowed origin.`);
  }
  return url.origin;
}

function parsedAuthenticatedUrl(env, field, protocols) {
  let url;
  try { url = new URL(env[field] || ''); } catch { throw new Error(`${field} is invalid.`); }
  if (!protocols.includes(url.protocol) || !url.hostname || !url.username || !url.password || (field === 'DATABASE_URL' && url.pathname === '/')) {
    throw new Error(`${field} must use an authenticated connection.`);
  }
  return url;
}

function isLoopback(hostname) {
  const normalized = hostname.replace(/\.$/, '').toLowerCase();
  const octets = normalized.split('.').map(Number);
  return normalized === 'localhost' || normalized === '[::1]' || normalized === '::1' ||
    (octets.length === 4 && octets.every(Number.isInteger) && octets[0] === 127);
}

function managedServiceUrl(env, field, protocols) {
  const url = parsedAuthenticatedUrl(env, field, protocols);
  if (isLoopback(url.hostname)) throw new Error(`${field} cannot use the local development service.`);
  return env[field];
}

function singleHostUrl(env, field, protocol, defaultPort) {
  const url = parsedAuthenticatedUrl(env, field, [protocol]);
  if (url.hostname !== '127.0.0.1' || (url.port || defaultPort) !== defaultPort) {
    throw new Error(`${field} must use the fixed production loopback service.`);
  }
  return env[field];
}

function httpsStorageUrl(env, field, { allowPath = false } = {}) {
  let url;
  try { url = new URL(env[field] || ''); } catch { throw new Error(`${field} must be an explicit HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== '/')) {
    throw new Error(`${field} must be an explicit HTTPS URL.`);
  }
  return env[field].replace(/\/$/, '');
}

function validateProductionEnvironment(env) {
  if (env.NODE_ENV !== 'production' || env.PAWSHOP_MODE !== 'production-admin-only') {
    throw new Error('Production requires NODE_ENV=production and PAWSHOP_MODE=production-admin-only.');
  }
  const topology = env.PAWSHOP_INFRA_TOPOLOGY;
  if (!['managed-tls', 'single-host-private'].includes(topology)) {
    throw new Error('PAWSHOP_INFRA_TOPOLOGY must select an approved private topology.');
  }

  let databaseUrl;
  let redisUrl;
  if (topology === 'managed-tls') {
    if (env.PAWSHOP_MANAGED_NETWORK_ATTESTED !== '1') {
      throw new Error('Managed services require an explicit private-network review gate.');
    }
    databaseUrl = managedServiceUrl(env, 'DATABASE_URL', ['postgres:', 'postgresql:']);
    if (!/[?&]sslmode=(?:require|verify-ca|verify-full)(?:&|$)/.test(databaseUrl)) throw new Error('DATABASE_URL must require TLS.');
    redisUrl = managedServiceUrl(env, 'REDIS_URL', ['rediss:']);
  } else {
    databaseUrl = singleHostUrl(env, 'DATABASE_URL', 'postgresql:', '5432');
    if (!/[?&]sslmode=disable(?:&|$)/.test(databaseUrl)) throw new Error('Single-host DATABASE_URL must explicitly disable network TLS on loopback.');
    redisUrl = singleHostUrl(env, 'REDIS_URL', 'redis:', '6379');
  }

  for (const field of ['JWT_SECRET', 'COOKIE_SECRET']) {
    if (!/^[a-f0-9]{64}$/i.test(env[field] || '')) throw new Error(`${field} must be a generated 32-byte hex secret.`);
  }
  if (env.JWT_SECRET === env.COOKIE_SECRET) throw new Error('JWT_SECRET and COOKIE_SECRET must be distinct.');

  const storeCors = explicitOrigin(env, 'STOREFRONT_ORIGIN');
  const adminCors = explicitOrigin(env, 'ADMIN_ORIGIN', { allowLoopbackHttp: topology === 'single-host-private' });
  if (topology === 'single-host-private' && !/^http:\/\/127\.0\.0\.1:\d+$/.test(adminCors)) {
    throw new Error('Single-host ADMIN_ORIGIN must use an explicit loopback port for an SSH tunnel.');
  }
  if (storeCors === adminCors) throw new Error('Storefront and admin origins must be separate.');

  const fileStorage = {
    file_url: httpsStorageUrl(env, 'S3_FILE_URL', { allowPath: true }),
    access_key_id: env.S3_ACCESS_KEY_ID || '',
    secret_access_key: env.S3_SECRET_ACCESS_KEY || '',
    region: env.S3_REGION || '',
    bucket: env.S3_BUCKET || '',
    endpoint: httpsStorageUrl(env, 'S3_ENDPOINT'),
    prefix: 'products/',
    acl: false,
    ...(env.S3_FORCE_PATH_STYLE === '1' ? { additional_client_config: { forcePathStyle: true } } : {}),
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(fileStorage.access_key_id) ||
      fileStorage.secret_access_key.length < 16 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(fileStorage.region) ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(fileStorage.bucket)) {
    throw new Error('Production object storage credentials or identifiers are invalid.');
  }
  if (!['', '0', '1'].includes(env.S3_FORCE_PATH_STYLE || '')) throw new Error('S3_FORCE_PATH_STYLE must be 0 or 1.');
  if (env.S3_DISABLE_ACL !== '1') throw new Error('Production object storage must explicitly disable per-object ACL headers.');

  const workerMode = env.MEDUSA_WORKER_MODE || 'shared';
  if (!['shared', 'server', 'worker'].includes(workerMode)) throw new Error('MEDUSA_WORKER_MODE must be shared, server, or worker.');
  if (topology === 'single-host-private' && workerMode !== 'shared') {
    throw new Error('Single-host production requires MEDUSA_WORKER_MODE=shared.');
  }
  return {
    databaseUrl,
    redisUrl,
    workerMode,
    topology,
    fileStorage,
    http: { storeCors, adminCors, authCors: adminCors, jwtSecret: env.JWT_SECRET, cookieSecret: env.COOKIE_SECRET },
  };
}

module.exports = { validateProductionEnvironment };
