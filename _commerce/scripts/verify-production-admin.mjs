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
// The process must be the one this environment file describes. Compare the
// marker against the validated mode instead of against a written-down profile:
// both profiles have to start, and an environment file that says "storefront"
// while the process reports "admin-only" is exactly the mistake worth refusing.
// Hard-coding one profile here would make the other profile unstartable rather
// than verified, which is how a service ends up unable to come up at all.
const expectedCommerce = config.commerceOpen ? 'open' : 'closed';
if (markerResponse.status !== 200 || marker.mode !== config.mode ||
    marker.topology !== 'single-host-private' || marker.commerce !== expectedCommerce) {
  throw new Error('Target process is not the production runtime this environment configures.');
}

// Both profiles share this much: the admin plane sits behind authentication, the
// loopback runtime serves the storefront shell, and the store namespace refuses
// every request that carries no key. That last refusal comes from Medusa's own
// API-key gate, which the HTTP loader installs on the app before every user
// middleware and every route, so it is answered with 400 in both profiles - and
// our own 503 gate for the namespace can only be reached once a key is presented.
const invariants = [
  ['GET', '/health', 200, undefined],
  ['GET', '/app', 200, undefined],
  ['GET', '/admin/products', 401, undefined],
  ['GET', '/admin/orders', 401, undefined],
  ['GET', '/store/products', 400, 'not_allowed'],
  ['POST', '/store/carts', 400, 'not_allowed'],
];

// The profiles differ in exactly one place that is observable without a
// credential: customer authentication has no framework gate ahead of it, so it
// is the door PawShop itself opens or closes. Closed, the middleware refuses it
// with the explicit 503. Open, the request reaches the emailpass provider, which
// rejects an empty body with 401 - a refusal, but one from the authentication
// code rather than from the mode gate, which is what proves the namespace is
// reachable. Assert the exact pair so neither answer can drift into the other.
invariants.push(config.commerceOpen
  ? ['POST', '/auth/customer/emailpass/register', 401, 'unauthorized']
  : ['POST', '/auth/customer/emailpass/register', 503, 'not_allowed']);

for (const [method, path, status, type] of invariants) {
  try {
    await expectHttpStatus(`${origin}${path}`, { method, status, type });
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

console.log(config.commerceOpen
  ? 'Production storefront boundary passed: private listeners and runtime identity verified; owner routes require authentication and customer commerce is open.'
  : 'Production admin boundary passed: private listeners and runtime identity verified; owner routes require authentication and customer commerce remains closed.');
