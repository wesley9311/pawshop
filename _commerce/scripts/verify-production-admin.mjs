import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { expectHttpStatus } = require('./http-probe.cjs');
const { productionPort } = require('./production-runtime.cjs');
const { assertLoopbackListeners } = require('./private-listener-policy.cjs');
const { validateProductionEnvironment } = require('../src/lib/production-policy.cjs');

const port = productionPort(process.env.PORT);
const origin = `http://127.0.0.1:${port}`;
const config = validateProductionEnvironment(process.env);
if (process.platform !== 'linux' || config.topology !== 'single-host-private') {
  throw new Error('This verifier requires the Linux single-host private production topology.');
}
assertLoopbackListeners(execFileSync('ss', ['-H', '-lnt'], { encoding: 'utf8' }), [5432, 6379, Number(port)]);

const markerResponse = await fetch(`${origin}/pawshop-runtime`, {
  redirect: 'manual', signal: AbortSignal.timeout(5000),
});
let marker;
try {
  const body = await markerResponse.text();
  if (body.length > 1024) throw new Error('Runtime marker response is too large.');
  marker = JSON.parse(body);
} catch {
  throw new Error('Production runtime marker is missing or malformed.');
}
if (markerResponse.status !== 200 || marker.mode !== 'production-admin-only' ||
    marker.topology !== 'single-host-private' || marker.commerce !== 'closed') {
  throw new Error('Target process is not the closed production admin runtime.');
}

// The store namespace is closed by Medusa's own API-key gate, which the HTTP
// loader installs on the app before every user middleware and every route. A
// store request that carries no key is therefore refused by that gate with 400,
// and our own 503 gate for the namespace can only be reached once a key is
// presented. Assert the refusal that is observable from outside the process:
// the store namespace answers no request without a key. Customer authentication
// routes have no such framework gate ahead of them, so they keep returning the
// explicit PawShop 503.
for (const [method, path, status, type] of [
  ['GET', '/health', 200, undefined],
  ['GET', '/app', 200, undefined],
  ['GET', '/admin/products', 401, undefined],
  ['GET', '/admin/orders', 401, undefined],
  ['GET', '/store/products', 400, 'not_allowed'],
  ['POST', '/store/carts', 400, 'not_allowed'],
  ['POST', '/auth/customer/emailpass/register', 503, 'not_allowed'],
]) {
  try {
    await expectHttpStatus(`${origin}${path}`, { method, status, type });
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

console.log('Production admin boundary passed: private listeners and runtime identity verified; owner routes require authentication and customer commerce remains closed.');
