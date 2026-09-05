'use strict';

function httpsOrigin(env, field) {
  const value = env[field] || '';
  let url;
  try { url = new URL(value); } catch { throw new Error(`${field} must be an explicit HTTPS origin.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${field} must be an explicit HTTPS origin.`);
  }
  return url.origin;
}

function privateUrl(env, field, protocols) {
  let url;
  try { url = new URL(env[field] || ''); } catch { throw new Error(`${field} is invalid.`); }
  if (!protocols.includes(url.protocol) || !url.hostname || !url.username || !url.password || (field === 'DATABASE_URL' && url.pathname === '/')) {
    throw new Error(`${field} must use an encrypted authenticated connection.`);
  }
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  const octets = hostname.split('.').map(Number);
  const loopbackV4 = octets.length === 4 && octets.every(Number.isInteger) && octets[0] === 127;
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || loopbackV4) throw new Error(`${field} cannot use the local development service.`);
  return env[field];
}

function validateProductionEnvironment(env) {
  if (env.NODE_ENV !== 'production' || env.PAWSHOP_MODE !== 'production-admin-only') {
    throw new Error('Production requires NODE_ENV=production and PAWSHOP_MODE=production-admin-only.');
  }
  const databaseUrl = privateUrl(env, 'DATABASE_URL', ['postgres:', 'postgresql:']);
  if (!/[?&]sslmode=(?:require|verify-ca|verify-full)(?:&|$)/.test(databaseUrl)) throw new Error('DATABASE_URL must require TLS.');
  const redisUrl = privateUrl(env, 'REDIS_URL', ['rediss:']);
  for (const field of ['JWT_SECRET', 'COOKIE_SECRET']) {
    if (!/^[a-f0-9]{64}$/i.test(env[field] || '')) throw new Error(`${field} must be a generated 32-byte hex secret.`);
  }
  if (env.JWT_SECRET === env.COOKIE_SECRET) throw new Error('JWT_SECRET and COOKIE_SECRET must be distinct.');
  const storeCors = httpsOrigin(env, 'STOREFRONT_ORIGIN');
  const adminCors = httpsOrigin(env, 'ADMIN_ORIGIN');
  const authCors = adminCors;
  if (storeCors === adminCors) throw new Error('Storefront and admin origins must be separate.');
  const workerMode = env.MEDUSA_WORKER_MODE || 'shared';
  if (!['shared', 'server', 'worker'].includes(workerMode)) throw new Error('MEDUSA_WORKER_MODE must be shared, server, or worker.');
  return {
    databaseUrl, redisUrl,
    workerMode,
    http: { storeCors, adminCors, authCors, jwtSecret: env.JWT_SECRET, cookieSecret: env.COOKIE_SECRET },
  };
}

module.exports = { validateProductionEnvironment };
