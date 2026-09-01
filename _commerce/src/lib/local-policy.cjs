'use strict';

function validateLocalEnvironment(env) {
  if (env.NODE_ENV === 'production') throw new Error('Production deployment is not enabled for this local foundation.');
  if (env.PAWSHOP_MODE !== 'local-admin-only') throw new Error('PAWSHOP_MODE must be local-admin-only.');
  const database = new URL(env.DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hostname !== '127.0.0.1' || database.port !== '54329' || database.pathname !== '/pawshop_dev') {
    throw new Error('Only the dedicated loopback pawshop_dev database on port 54329 is allowed.');
  }
  for (const field of ['JWT_SECRET', 'COOKIE_SECRET']) {
    if (!/^[a-f0-9]{64}$/i.test(env[field] || '')) throw new Error(`${field} must be a generated 32-byte hex secret.`);
  }
  return {
    databaseUrl: env.DATABASE_URL,
    http: {
      storeCors: 'http://127.0.0.1:4173,http://localhost:4173',
      adminCors: 'http://127.0.0.1:9000,http://localhost:9000',
      authCors: 'http://127.0.0.1:9000,http://localhost:9000',
      jwtSecret: env.JWT_SECRET,
      cookieSecret: env.COOKIE_SECRET,
    },
  };
}

// This phase exposes no storefront APIs, including reads or authentication.
// CORS and the absence of a public API key are not security boundaries.
function blockedPublicRoute(pathname) {
  return /^\/(?:store(?:\/|$)|auth\/customer(?:\/|$))/.test(pathname);
}

module.exports = { validateLocalEnvironment, blockedPublicRoute };
