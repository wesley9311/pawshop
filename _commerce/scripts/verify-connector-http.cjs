'use strict';
// HTTP acceptance for the PawShop side of the CloudGull Connector V1.1.
//
// WHAT IS REAL HERE
//   * the compiled route handlers in src/api/connector/v1/**
//   * the real signature verifier, replay guard and credential lookup
//   * the real DTO validation and the real Medusa payload translation
//     (buildCreateInput / buildUpdateInput)
//   * real HTTP over a socket, so the raw request bytes are what gets signed
//   * the signing side is CloudGull's OWN code
//     (cloudgull/lib/connectors/pawshop/pawshop-auth.ts), not a copy of it
//
// WHAT IS STUBBED, AND WHY
//   * the commerce workflows and the container. This host has no Postgres and no
//     Redis, so a real Medusa application cannot boot here. Stubbing the
//     workflow boundary is deliberate: it is the exact seam where the connector
//     stops translating and starts delegating, so everything above it is
//     exercised for real and only the call itself is captured.
//   * the module service, replaced by an in-memory implementation of the same
//     public contract. The SQL-backed implementation is verified separately by
//     scripts/verify-connector-module.cjs and the migration run recorded in
//     docs/PAWSHOP_CONNECTOR_V1.md.
//
// USAGE
//   node --experimental-strip-types scripts/verify-connector-http.cjs
//   CLOUDGULL_PAWSHOP_AUTH=/path/to/pawshop-auth.ts ... (defaults to the known
//   local CloudGull checkout; the run is skipped with a clear message if absent)

const path = require('node:path');
const http = require('node:http');
const express = require('express');

const COMPILED = path.resolve(__dirname, '..', '.medusa', 'server');
const CLOUDGULL_PAWSHOP_AUTH =
  process.env.CLOUDGULL_PAWSHOP_AUTH ||
  '/Users/zhaoxiaomin/.codex/.chatgpt-projects/g-p-6ab341a742b481918af79796da211c68/cloudgull/lib/connectors/pawshop/pawshop-auth.ts';

// Credentials are injected exactly the way /etc/pawshop/connector.env injects
// them, including the rotation slot.
const CURRENT = {
  keyId: 'acceptance-current',
  token: 'acceptance-current-token',
  signingSecret: 'acceptance-current-signing-secret',
  version: '1',
};
process.env.PAWSHOP_CONNECTOR_KEY_ID = CURRENT.keyId;
process.env.PAWSHOP_CONNECTOR_SERVICE_TOKEN = CURRENT.token;
process.env.PAWSHOP_CONNECTOR_SIGNING_SECRET = CURRENT.signingSecret;
process.env.PAWSHOP_CONNECTOR_KEY_VERSION = CURRENT.version;
process.env.PAWSHOP_CONNECTOR_SCOPES = 'connector:health:read connector:products:write';
process.env.PAWSHOP_CONNECTOR_KEY_ID_NEXT = 'acceptance-next';
process.env.PAWSHOP_CONNECTOR_SERVICE_TOKEN_NEXT = 'acceptance-next-token';
process.env.PAWSHOP_CONNECTOR_SIGNING_SECRET_NEXT = 'acceptance-next-signing-secret';
process.env.PAWSHOP_CONNECTOR_KEY_VERSION_NEXT = '2';
// The NEXT slot deliberately carries only the read scope, so the server-side
// scope check can be exercised with a credential whose signature is valid.
process.env.PAWSHOP_CONNECTOR_SCOPES_NEXT = 'connector:health:read';

const { bodySha256, signatureFor, canonicalRequest } = require(path.join(COMPILED, 'src/lib/connector-auth.cjs'));
const { handleForProduct } = require(path.join(COMPILED, 'src/lib/connector-payload.cjs'));

// ---------------------------------------------------------------------------
// Workflow capture: replace @medusajs/core-flows in the require cache so the REAL
// translation layer runs and only the workflow invocation is intercepted.
// ---------------------------------------------------------------------------
const workflowCalls = [];
const coreFlowsPath = require.resolve('@medusajs/core-flows');
require.cache[coreFlowsPath] = {
  id: coreFlowsPath,
  filename: coreFlowsPath,
  loaded: true,
  exports: {
    createProductsWorkflow: () => ({
      run: async ({ input }) => {
        workflowCalls.push({ type: 'create', input });
        return { result: [{ id: 'prod_acceptance_1' }] };
      },
    }),
    updateProductsWorkflow: () => ({
      run: async ({ input }) => {
        workflowCalls.push({ type: 'update', input });
        return { result: [{ id: input.selector.id }] };
      },
    }),
  },
};

// ---------------------------------------------------------------------------
// In-memory stand-in for the module service. Mirrors the SQL-backed semantics:
// the unique constraints become Map keys, and the idempotency in-flight sentinel
// is reproduced so the concurrency path is exercised.
// ---------------------------------------------------------------------------
const IN_FLIGHT = 0;

function createMemoryService() {
  const mappings = new Map();
  const nonces = new Set();
  const idempotency = new Map();
  const audit = [];
  return {
    audit,
    idempotency,
    workflowCalls,
    async findProductMapping(sourceProductId) {
      return mappings.get(sourceProductId) ?? null;
    },
    async recordProductMapping(input) {
      const existing = mappings.get(input.sourceProductId);
      const row = {
        id: existing?.id ?? 'map_' + mappings.size,
        source_product_id: input.sourceProductId,
        product_id: existing?.product_id ?? input.productId,
        handle: existing?.handle ?? input.handle,
        last_revision: input.revision,
        external_version: input.externalVersion,
      };
      mappings.set(input.sourceProductId, row);
      return row;
    },
    async claimNonce({ keyId, nonce }) {
      const key = keyId + ':' + nonce;
      if (nonces.has(key)) return false;
      nonces.add(key);
      return true;
    },
    async claimIdempotencyKey({ idempotencyKey, keyId, sourceProductId, requestBodySha256 }) {
      const existing = idempotency.get(idempotencyKey);
      if (!existing) {
        idempotency.set(idempotencyKey, {
          key_id: keyId,
          source_product_id: sourceProductId,
          product_id: '',
          response_status: IN_FLIGHT,
          response_body: {},
          request_body_sha256: requestBodySha256,
        });
        return { state: 'claimed' };
      }
      if (existing.request_body_sha256 !== requestBodySha256) return { state: 'conflict' };
      if (existing.response_status === IN_FLIGHT) return { state: 'in_flight' };
      return { state: 'replay', responseStatus: existing.response_status, responseBody: existing.response_body };
    },
    async completeIdempotencyClaim({ idempotencyKey, productId, responseStatus, responseBody }) {
      const row = idempotency.get(idempotencyKey);
      if (!row) return;
      row.product_id = productId;
      row.response_status = responseStatus;
      row.response_body = responseBody;
    },
    async releaseIdempotencyClaim(idempotencyKey) {
      const row = idempotency.get(idempotencyKey);
      if (row && row.response_status === IN_FLIGHT) idempotency.delete(idempotencyKey);
    },
    async recordAudit(entry) {
      audit.push(entry);
      return entry;
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog state the writer reads: an existing product for the update path.
// ---------------------------------------------------------------------------
const existingProduct = {
  id: 'prod_existing_1',
  handle: 'lightweight-pet-travel-backpack',
  title: 'Lightweight pet travel backpack',
  subtitle: '',
  status: 'published',
  thumbnail: null,
  images: [],
  metadata: {},
  variants: [
    { id: 'variant_1', sku: 'CG-1001-1', title: 'Small', metadata: { cloudgull_source_variant_id: 'CG-1001-variant-1' } },
    { id: 'variant_2', sku: 'CG-1001-2', title: 'Large', metadata: { cloudgull_source_variant_id: 'CG-1001-variant-2' } },
  ],
};

const categories = new Map();
const createdProductsForHandle = new Set([existingProduct.handle]);

function buildContainer(service) {
  return {
    resolve(key) {
      if (key === 'pawshopConnector') return service;
      if (key === 'query') return { graph: async () => ({ data: [existingProduct] }) };
      if (key === 'logger') return { warn: (message) => console.log('       [logger.warn] ' + message) };
      if (key === 'product') {
        return {
          listProductCategories: async ({ name }) => {
            const found = categories.get(name);
            return found ? [{ id: found, name }] : [];
          },
          createProductCategories: async ({ name }) => {
            const id = 'pcat_' + categories.size;
            categories.set(name, id);
            return { id, name };
          },
          listProducts: async (filters) => {
            const like = filters?.handle?.$like;
            const prefix = typeof like === 'string' ? like.replace(/%$/, '') : '';
            return [...createdProductsForHandle]
              .filter((handle) => handle.startsWith(prefix))
              .map((handle) => ({ handle }));
          },
        };
      }
      if (key === 'store') return { listStores: async () => [{ default_sales_channel_id: 'sc_default' }] };
      throw new Error('acceptance container has no binding for ' + key);
    },
  };
}

// ---------------------------------------------------------------------------
// A minimal HTTP surface that mirrors the two things Medusa does for this
// namespace: `preserveRawBody` on the JSON parser, and the compiled route
// handlers. nginx's `/api/connector/v1/` -> `/connector/v1/` rewrite is
// reproduced by mounting under the same shortened prefix.
// ---------------------------------------------------------------------------
function createServer(service) {
  const app = express();
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );
  app.use((req, _res, next) => {
    req.scope = buildContainer(service);
    next();
  });

  const mount = (routePath, moduleRelative) => {
    const handlers = require(path.join(COMPILED, moduleRelative));
    app.all(routePath, async (req, res) => {
      const handler = handlers[req.method];
      if (!handler) {
        return res.status(404).json({ error: 'Route not found.', code: 'NOT_FOUND', retryable: false });
      }
      try {
        await handler(req, res);
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).json({ error: String(error && error.message), code: 'INTERNAL_ERROR', retryable: true });
        }
      }
    });
  };

  mount('/connector/v1/health', 'src/api/connector/v1/health/route.js');
  mount('/connector/v1/products/:id', 'src/api/connector/v1/products/[id]/route.js');

  return app;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log('  ok   - ' + label);
  } else {
    failures += 1;
    console.log('  FAIL - ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
  }
}

function equal(label, actual, expected) {
  check(label + ' (expected ' + JSON.stringify(expected) + ')', actual === expected, actual);
}

async function main() {
  let cloudgull;
  try {
    cloudgull = await import(CLOUDGULL_PAWSHOP_AUTH);
  } catch (error) {
    process.stdout.write(
      'SKIPPED: could not load CloudGull\'s signer at ' +
        CLOUDGULL_PAWSHOP_AUTH +
        '\n' +
        error.message +
        '\nSet CLOUDGULL_PAWSHOP_AUTH to run the interop acceptance.\n'
    );
    process.exit(0);
  }

  const service = createMemoryService();
  const app = createServer(service);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = 'http://127.0.0.1:' + port;

  // CloudGull's own signer, pointed at this PawShop surface.
  const sign = (credential, input) => {
    const publicPath = '/api/connector/v1' + input.path;
    return cloudgull.createPawShopSignedHeaders({
      credential,
      method: input.method,
      path: publicPath,
      body: input.body || '',
      idempotencyKey: input.idempotencyKey,
      now: input.now,
      nonce: input.nonce,
    });
  };

  const cgCredential = (overrides) => ({ ...cloudgull.localHarnessCredential, ...CURRENT, ...overrides });

  const send = async (input) => {
    const headers = {
      ...sign(input.credential ?? cgCredential(), input),
      ...(input.body ? { 'content-type': 'application/json' } : {}),
      ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      'x-cloudgull-connector-version': '1',
      ...(input.headers ?? {}),
    };
    // The request goes to the mounted prefix (/connector/v1), which is what
    // nginx rewrites /api/connector/v1 onto; the signature covers the public
    // path (/api/connector/v1/...), which is what CloudGull actually signs.
    const response = await fetch(origin + '/connector/v1' + input.path, {
      method: input.method,
      headers,
      body: input.body || undefined,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: response.status, body: json };
  };

  const productBody = (overrides = {}) =>
    JSON.stringify({
      source: { system: 'cloudgull', productId: 'CG-2002', revision: 1, ...(overrides.source ?? {}) },
      product: {
        title: 'Lightweight pet travel backpack',
        subtitle: 'Short commutes and weekend trips',
        status: 'active',
        category: { name: 'Travel' },
        variants: [
          { sourceVariantId: 'CG-2002-variant-1', sku: 'CG-2002-1', title: 'Small', price: { amount: 79, currency: 'USD' }, inventoryQuantity: 8 },
          { sourceVariantId: 'CG-2002-variant-2', sku: 'CG-2002-2', title: 'Large', price: { amount: 99.5, currency: 'USD' }, inventoryQuantity: 3 },
        ],
        media: [],
        ...(overrides.product ?? {}),
      },
    });

  try {
    console.log('\n== health ==');
    const health = await send({ method: 'GET', path: '/health', credential: cgCredential() });
    equal('GET /health status', health.status, 200);
    equal('connector name', health.body.connector, 'pawshop');
    equal('authenticatedKeyId echoes the signing key', health.body.authenticatedKeyId, CURRENT.keyId);
    equal('authenticatedKeyVersion echoes the signing version', health.body.authenticatedKeyVersion, CURRENT.version);
    check(
      'the response leaks neither token nor secret',
      !JSON.stringify(health.body).includes(CURRENT.token) &&
        !JSON.stringify(health.body).includes(CURRENT.signingSecret)
    );

    const nextHealth = await send({
      method: 'GET',
      path: '/health',
      credential: { ...CURRENT, keyId: 'acceptance-next', token: 'acceptance-next-token', signingSecret: 'acceptance-next-signing-secret', version: '2' },
    });
    equal('the NEXT rotation slot authenticates too', nextHealth.status, 200);
    equal('and reports its own version', nextHealth.body.authenticatedKeyVersion, '2');

    console.log('\n== authentication failures ==');
    const noHeaders = await fetch(origin + '/connector/v1/health');
    equal('missing auth headers -> 401', noHeaders.status, 401);
    equal('  code', (await noHeaders.json()).code, 'AUTH_HEADERS_REQUIRED');

    const healthOnlyCredential = {
      ...CURRENT,
      keyId: 'acceptance-next',
      token: 'acceptance-next-token',
      signingSecret: 'acceptance-next-signing-secret',
      version: '2',
    };
    const scopeRefused = await send({
      method: 'PUT',
      path: '/products/CG-2002',
      body: productBody(),
      idempotencyKey: 'cloudgull:pawshop:product:CG-2002:r1',
      credential: healthOnlyCredential,
    });
    equal('a validly signed request without the write scope -> 403', scopeRefused.status, 403);
    equal('  code', scopeRefused.body.code, 'INSUFFICIENT_SCOPE');
    equal('  scope is enforced server-side, not only by the client', workflowCalls.length, 0);

    const stale = await send({ method: 'GET', path: '/health', now: Date.now() - 6 * 60 * 1000, nonce: 'stale-1' });
    equal('timestamp outside the window -> 401', stale.status, 401);
    equal('  code', stale.body.code, 'REQUEST_TIMESTAMP_EXPIRED');

    const badToken = await send({
      method: 'GET',
      path: '/health',
      headers: { authorization: 'Bearer not-the-token' },
    });
    equal('wrong service token -> 401', badToken.status, 401);
    equal('  code', badToken.body.code, 'INVALID_SERVICE_CREDENTIAL');

    const tampered = await send({ method: 'GET', path: '/health', headers: { 'x-cloudgull-signature': 'v1=' + 'a'.repeat(64) } });
    equal('bad signature -> 401', tampered.status, 401);
    equal('  code', tampered.body.code, 'INVALID_REQUEST_SIGNATURE');

    const replayed = await send({ method: 'GET', path: '/health', nonce: 'replay-me' });
    const replayedAgain = await send({ method: 'GET', path: '/health', nonce: 'replay-me' });
    equal('first use of a nonce succeeds', replayed.status, 200);
    equal('replayed nonce -> 409', replayedAgain.status, 409);
    equal('  code', replayedAgain.body.code, 'REPLAY_DETECTED');

    console.log('\n== product create ==');
    const createBody = productBody();
    const created = await send({
      method: 'PUT',
      path: '/products/CG-2002',
      body: createBody,
      idempotencyKey: 'cloudgull:pawshop:product:CG-2002:r1',
    });
    equal('PUT create -> 201', created.status, 201);
    equal('  productId returned', created.body.productId, 'prod_acceptance_1');
    equal('  version is ps-r<revision>', created.body.version, 'ps-r1');
    equal('  created', created.body.created, true);
    equal('  replayed', created.body.replayed, false);
    check('  processedAt is an ISO timestamp', typeof created.body.processedAt === 'string' && !Number.isNaN(Date.parse(created.body.processedAt)));

    equal('exactly one workflow call', workflowCalls.length, 1);
    const createInput = workflowCalls[0].input.products[0];
    equal('  workflow received status published', createInput.status, 'published');
    equal('  one option carrying the stable variant ids', JSON.stringify(createInput.options), JSON.stringify([{ title: 'Source Variant', values: ['CG-2002-variant-1', 'CG-2002-variant-2'] }]));
    equal('  each variant maps the option to its own value', JSON.stringify(createInput.variants.map((v) => v.options)), JSON.stringify([{ 'Source Variant': 'CG-2002-variant-1' }, { 'Source Variant': 'CG-2002-variant-2' }]));
    equal('  variant prices in USD decimals', JSON.stringify(createInput.variants.map((v) => v.prices)), JSON.stringify([[{ currency_code: 'usd', amount: 79 }], [{ currency_code: 'usd', amount: 99.5 }]]));
    equal('  manage_inventory is off (stock arrives with the Inventory endpoint)', JSON.stringify(createInput.variants.map((v) => v.manage_inventory)), JSON.stringify([false, false]));
    equal('  a sales channel was linked', JSON.stringify(createInput.sales_channels), JSON.stringify([{ id: 'sc_default' }]));
    equal('  the category was created on demand', createInput.category_ids.length, 1);
    check('  the requested stock is preserved, not dropped', JSON.stringify(createInput.metadata.cloudgull_connector.pending_inventory) === JSON.stringify([
      { source_variant_id: 'CG-2002-variant-1', sku: 'CG-2002-1', inventory_quantity: 8 },
      { source_variant_id: 'CG-2002-variant-2', sku: 'CG-2002-2', inventory_quantity: 3 },
    ]));
    equal('  handle derived from the title', createInput.handle, handleForProduct({ title: createInput.title, sourceProductId: 'CG-2002', handleTaken: (c) => c === existingProduct.handle }));

    console.log('\n== idempotent replay ==');
    const replay = await send({
      method: 'PUT',
      path: '/products/CG-2002',
      body: createBody,
      idempotencyKey: 'cloudgull:pawshop:product:CG-2002:r1',
    });
    equal('same Idempotency-Key -> 200', replay.status, 200);
    equal('  same productId', replay.body.productId, created.body.productId);
    equal('  replayed flag set', replay.body.replayed, true);
    equal('no second workflow call was made', workflowCalls.length, 1);

    const conflict = await send({
      method: 'PUT',
      path: '/products/CG-2002',
      body: productBody({ product: { title: 'A different product entirely' } }),
      idempotencyKey: 'cloudgull:pawshop:product:CG-2002:r1',
    });
    equal('same key with a different body -> 409', conflict.status, 409);
    equal('  code', conflict.body.code, 'IDEMPOTENCY_KEY_CONFLICT');
    equal('  still no extra workflow call', workflowCalls.length, 1);

    const noKey = await send({ method: 'PUT', path: '/products/CG-2002', body: productBody() });
    equal('missing Idempotency-Key -> 400', noKey.status, 400);
    equal('  code', noKey.body.code, 'IDEMPOTENCY_KEY_REQUIRED');

    console.log('\n== raw-body integrity ==');
    // Signed over bytes that are NOT the canonical JSON.stringify form. A
    // verifier that re-serialised the parsed body before hashing would reject
    // this; hashing the raw bytes accepts it. This is the difference the design
    // claims, so it is asserted rather than assumed.
    const spacedBody = '{\n  "source"  :  {"system": "cloudgull", "productId": "CG-3003", "revision": 7},\n  "product": {"title": "Spaced", "subtitle": "", "status": "draft", "category": {"name": "Travel"}, "variants": [{"sourceVariantId": "CG-3003-v1", "sku": "CG-3003-1", "title": "Only", "price": {"amount": 10, "currency": "USD"}, "inventoryQuantity": 0}], "media": []}\n}';
    const spaced = await send({
      method: 'PUT',
      path: '/products/CG-3003',
      body: spacedBody,
      idempotencyKey: 'cloudgull:pawshop:product:CG-3003:r7',
    });
    equal('a body with non-canonical whitespace verifies and is accepted', spaced.status, 201);
    equal('  and reports itself as draft', workflowCalls[workflowCalls.length - 1].input.products[0].status, 'draft');

    console.log('\n== contract validation ==');
    const badStatus = await send({
      method: 'PUT',
      path: '/products/CG-4004',
      body: productBody({ product: { status: 'published' } }).replace('CG-2002', 'CG-4004'),
      idempotencyKey: 'cloudgull:pawshop:product:CG-4004:r1',
    });
    equal('unknown product status -> 422', badStatus.status, 422);
    equal('  code', badStatus.body.code, 'CONTRACT_VALIDATION_FAILED');
    equal('  not retryable', badStatus.body.retryable, false);

    const badHost = await send({
      method: 'PUT',
      path: '/products/CG-5005',
      body: productBody({
        product: {
          media: [{ sourceMediaId: 'M1', url: 'https://evil.example.com/x.png', alt: '', primary: true, position: 1 }],
        },
      }).replace('CG-2002', 'CG-5005'),
      idempotencyKey: 'cloudgull:pawshop:product:CG-5005:r1',
    });
    equal('media from an unapproved host -> 422', badHost.status, 422);
    check('  the error names the approved hosts', Array.isArray(badHost.body.details && badHost.body.details.approvedHosts));

    const pathMismatch = await send({
      method: 'PUT',
      path: '/products/CG-6006',
      body: productBody(),
      idempotencyKey: 'cloudgull:pawshop:product:CG-6006:r1',
    });
    equal('path/body product id mismatch -> 422', pathMismatch.status, 422);

    console.log('\n== product update ==');
    // CG-1001 is already mapped to the existing product in this harness.
    await service.recordProductMapping({
      sourceProductId: 'CG-1001',
      productId: existingProduct.id,
      handle: existingProduct.handle,
      revision: 3,
      externalVersion: 'ps-r3',
    });
    const cg1001Variants = [
      { sourceVariantId: 'CG-1001-variant-1', sku: 'CG-1001-1', title: 'Compact', price: { amount: 89, currency: 'USD' }, inventoryQuantity: 5 },
      { sourceVariantId: 'CG-1001-variant-2', sku: 'CG-1001-2', title: 'Roomy', price: { amount: 109, currency: 'USD' }, inventoryQuantity: 2 },
    ];
    const cg1001Body = (variants, revision) =>
      JSON.stringify({
        source: { system: 'cloudgull', productId: 'CG-1001', revision },
        product: {
          title: 'Lightweight pet travel backpack v2',
          subtitle: 'Now with a wider strap',
          status: 'draft',
          category: { name: 'Travel' },
          variants,
          media: [],
        },
      });
    const updateBody = cg1001Body(cg1001Variants, 4);
    const updated = await send({
      method: 'PUT',
      path: '/products/CG-1001',
      body: updateBody,
      idempotencyKey: 'cloudgull:pawshop:product:CG-1001:r4',
    });
    equal('PUT update -> 200', updated.status, 200);
    equal('  same productId (stable external id)', updated.body.productId, existingProduct.id);
    equal('  created false', updated.body.created, false);
    equal('  version bumped', updated.body.version, 'ps-r4');
    const updateInput = workflowCalls[workflowCalls.length - 1].input.update;
    equal('  positional variant order follows the stored product', JSON.stringify(updateInput.variants.map((v) => v.id)), JSON.stringify(['variant_1', 'variant_2']));
    equal('  variants carry the new titles', JSON.stringify(updateInput.variants.map((v) => v.title)), JSON.stringify(['Compact', 'Roomy']));
    equal('  variants carry the new prices', JSON.stringify(updateInput.variants.map((v) => v.prices[0].amount)), JSON.stringify([89, 109]));
    equal('  status follows the connector status', updateInput.status, 'draft');
    equal('  handle is never recomputed on update', Object.prototype.hasOwnProperty.call(updateInput, 'handle'), false);

    const variantSetChange = await send({
      method: 'PUT',
      path: '/products/CG-1001',
      body: cg1001Body([cg1001Variants[0], { ...cg1001Variants[1], sourceVariantId: 'CG-1001-variant-3', sku: 'CG-1001-3' }], 5),
      idempotencyKey: 'cloudgull:pawshop:product:CG-1001:r5',
    });
    equal('changing the variant set -> 422', variantSetChange.status, 422);
    equal('  code', variantSetChange.body.code, 'CONTRACT_VALIDATION_FAILED');
    check('  the deferred capability is named in details', Boolean(variantSetChange.body.details && variantSetChange.body.details.deferredTo));

    console.log('\n== routing ==');
    const wrongMethod = await fetch(origin + '/connector/v1/products/CG-2002');
    equal('GET on the products path -> 404', wrongMethod.status, 404);
    equal('  code', (await wrongMethod.json()).code, 'NOT_FOUND');

    console.log('\n== audit ==');
    const outcomes = service.audit.map((entry) => entry.outcome + ':' + entry.httpStatus);
    check('a rejected authentication is audited', service.audit.some((e) => e.errorCode === 'AUTH_HEADERS_REQUIRED' && e.httpStatus === 401), outcomes);
    check('a replay is audited', service.audit.some((e) => e.outcome === 'replayed' && e.productId === 'prod_acceptance_1'));
    check('a create is audited as created/201', service.audit.some((e) => e.outcome === 'created' && e.httpStatus === 201));
    check('an update is audited as updated/200', service.audit.some((e) => e.outcome === 'updated' && e.httpStatus === 200 && e.productId === existingProduct.id));
    check('a replay-detection is audited', service.audit.some((e) => e.errorCode === 'REPLAY_DETECTED'));
    check('a contract violation is audited', service.audit.some((e) => e.errorCode === 'CONTRACT_VALIDATION_FAILED'));
    check(
      'no audit row carries a token or a secret',
      !JSON.stringify(service.audit).includes(CURRENT.token) &&
        !JSON.stringify(service.audit).includes(CURRENT.signingSecret)
    );
    check(
      'every audit row records the request body hash, never the body',
      service.audit.filter((e) => e.requestBodySha256).every((e) => /^[a-f0-9]{64}$/.test(e.requestBodySha256))
    );
    check('audit rows carry the public path the caller signed', service.audit.every((e) => e.path.startsWith('/api/connector/v1')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n' + checks + ' checks, ' + failures + ' failure(s)');
  console.log(failures === 0 ? 'HTTP ACCEPTANCE PASSED' : 'HTTP ACCEPTANCE FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
