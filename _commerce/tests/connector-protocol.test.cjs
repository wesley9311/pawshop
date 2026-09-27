'use strict';
// Contract tests for the PawShop side of the CloudGull Connector V1.1 request
// protocol.
//
// The GOLDEN_* fixtures below were produced by running CloudGull's own signer
// (`cloudgull/lib/connectors/pawshop/pawshop-auth.ts`,
// `createCanonicalPawShopRequest` + `createPawShopSignedHeaders`) over these
// exact inputs. They are not hand-computed: if either implementation drifts, the
// canonical preimage or the HMAC changes and these tests fail. That is the whole
// point — "identical to the CloudGull contract" is verified against the
// CloudGull code, not against a restatement of it.
//
// Reproduce with (from the CloudGull checkout):
//   node --experimental-strip-types scripts/generate-connector-goldens.mjs
// See docs/PAWSHOP_CONNECTOR_V1.md -> "Evidence".

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONNECTOR_MOUNT_PREFIX,
  CONNECTOR_PUBLIC_PREFIX,
  canonicalRequest,
  bodySha256,
  publicPathFromMountedUrl,
  readConnectorCredentials,
  signatureFor,
  verifyConnectorRequest,
} = require('../src/lib/connector-auth.cjs');
const { ConnectorRequestError } = require('../src/lib/connector-errors.cjs');
const {
  buildCreateInput,
  buildUpdateInput,
  externalVersionFor,
  handleForProduct,
  parseProductUpsertRequest,
} = require('../src/lib/connector-payload.cjs');

const GOLDEN_CREDENTIAL = Object.freeze({
  keyId: 'golden-key',
  token: 'golden-token',
  signingSecret: 'golden-signing-secret',
  scopes: ['connector:health:read', 'connector:products:write'],
  version: '1',
});

const GOLDEN_TIMESTAMP = '1790000000000';

const GOLDEN_HEALTH = Object.freeze({
  method: 'GET',
  path: '/api/connector/v1/health',
  body: '',
  nonce: 'golden-nonce-health-get',
  idempotencyKey: '',
  canonical: 'GET\n/api/connector/v1/health\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n1790000000000\ngolden-nonce-health-get\n',
  signature: 'v1=648c8f7c409f1315a9f45dee75994f16b8bfce71c95438e7ca8d6e670afe95ff',
  bodySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
});

const GOLDEN_PRODUCT_BODY =
  '{"source":{"system":"cloudgull","productId":"CG-1001","revision":3},"product":{"title":"Lightweight pet travel backpack","subtitle":"Short commutes and weekend trips","status":"active","category":{"name":"Travel"},"variants":[{"sourceVariantId":"CG-1001-variant-1","sku":"CG-1001-1","title":"Variant 1","price":{"amount":79,"currency":"USD"},"inventoryQuantity":8}],"media":[]}}';

const GOLDEN_PRODUCT = Object.freeze({
  method: 'PUT',
  path: '/api/connector/v1/products/CG-1001',
  body: GOLDEN_PRODUCT_BODY,
  nonce: 'golden-nonce-product-put',
  idempotencyKey: 'cloudgull:pawshop:product:CG-1001:r3',
  canonical: 'PUT\n/api/connector/v1/products/CG-1001\n9425cfc7ae82d6a7d7fb4ee015800b991aa4bf770eb3d34f4f3ebe8f96faf1c0\n1790000000000\ngolden-nonce-product-put\ncloudgull:pawshop:product:CG-1001:r3',
  signature: 'v1=1e22c2577854d1469834d142909757a170efcb2ff755323e5f356a6b38972092',
  bodySha256: '9425cfc7ae82d6a7d7fb4ee015800b991aa4bf770eb3d34f4f3ebe8f96faf1c0',
});

function headersFor(caseInput, credential = GOLDEN_CREDENTIAL, overrides = {}) {
  const canonical = canonicalRequest({
    method: caseInput.method,
    path: caseInput.path,
    body: caseInput.body,
    timestamp: GOLDEN_TIMESTAMP,
    nonce: caseInput.nonce,
    idempotencyKey: caseInput.idempotencyKey,
  });
  return {
    authorization: `Bearer ${credential.token}`,
    'x-cloudgull-key-id': credential.keyId,
    'x-cloudgull-key-version': credential.version,
    'x-cloudgull-timestamp': GOLDEN_TIMESTAMP,
    'x-cloudgull-nonce': caseInput.nonce,
    'x-cloudgull-signature': signatureFor(credential.signingSecret, canonical),
    ...(caseInput.idempotencyKey ? { 'idempotency-key': caseInput.idempotencyKey } : {}),
    ...overrides,
  };
}

function memoryNonceClaimer() {
  const seen = new Set();
  return async ({ keyId, nonce }) => {
    const key = `${keyId}:${nonce}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function verify(caseInput, options = {}) {
  return verifyConnectorRequest({
    headers: options.headers ?? headersFor(caseInput, options.credential),
    method: caseInput.method,
    publicPath: caseInput.path,
    rawBody: caseInput.body,
    requiredScope: options.requiredScope ?? 'connector:products:write',
    credentials: options.credentials ?? [GOLDEN_CREDENTIAL],
    claimNonce: options.claimNonce ?? memoryNonceClaimer(),
    now: options.now ?? Number(GOLDEN_TIMESTAMP),
    maxClockSkewMs: options.maxClockSkewMs,
  });
}

async function expectConnectorError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ConnectorRequestError, `expected ConnectorRequestError, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test('canonical preimage and HMAC match the CloudGull signer byte for byte', () => {
  for (const goldenCase of [GOLDEN_HEALTH, GOLDEN_PRODUCT]) {
    const canonical = canonicalRequest({
      method: goldenCase.method,
      path: goldenCase.path,
      body: goldenCase.body,
      timestamp: GOLDEN_TIMESTAMP,
      nonce: goldenCase.nonce,
      idempotencyKey: goldenCase.idempotencyKey,
    });
    assert.equal(canonical, goldenCase.canonical, `canonical preimage drifted for ${goldenCase.path}`);
    assert.equal(bodySha256(goldenCase.body), goldenCase.bodySha256);
    assert.equal(
      signatureFor(GOLDEN_CREDENTIAL.signingSecret, canonical),
      goldenCase.signature,
      `HMAC drifted for ${goldenCase.path}`
    );
  }
});

test('a request signed by the CloudGull algorithm is accepted', async () => {
  const health = await verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read' });
  assert.equal(health.keyId, 'golden-key');
  assert.equal(health.keyVersion, '1');
  assert.deepEqual(health.scopes, ['connector:health:read', 'connector:products:write']);

  const product = await verify(GOLDEN_PRODUCT);
  assert.equal(product.keyId, 'golden-key');
});

test('the signed path is the public path, not the mounted path', () => {
  assert.equal(CONNECTOR_PUBLIC_PREFIX, '/api/connector/v1');
  assert.equal(CONNECTOR_MOUNT_PREFIX, '/connector/v1');
  assert.equal(publicPathFromMountedUrl('/connector/v1/health'), '/api/connector/v1/health');
  assert.equal(
    publicPathFromMountedUrl('/connector/v1/products/CG-1001?cursor=next'),
    '/api/connector/v1/products/CG-1001?cursor=next'
  );
  assert.throws(() => publicPathFromMountedUrl('/store/products'), /outside/);
});

test('authentication failures reproduce the contract status and code, in the contract order', async () => {
  // 1. Headers present at all.
  await expectConnectorError(
    verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read', headers: {} }),
    'AUTH_HEADERS_REQUIRED',
    401
  );
  await expectConnectorError(
    verify(GOLDEN_PRODUCT, { headers: { ...headersFor(GOLDEN_PRODUCT), authorization: GOLDEN_CREDENTIAL.token } }),
    'AUTH_HEADERS_REQUIRED',
    401
  );

  // 2. Timestamp window (5 minutes each way), checked before the signature.
  await expectConnectorError(
    verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read', now: Number(GOLDEN_TIMESTAMP) + 5 * 60_000 + 1 }),
    'REQUEST_TIMESTAMP_EXPIRED',
    401
  );
  await expectConnectorError(
    verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read', now: Number(GOLDEN_TIMESTAMP) - 5 * 60_000 - 1 }),
    'REQUEST_TIMESTAMP_EXPIRED',
    401
  );
  // Exactly on the boundary is still inside the window.
  await verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read', now: Number(GOLDEN_TIMESTAMP) + 5 * 60_000 });

  // 3. Unknown key id, wrong token.
  await expectConnectorError(
    verify(GOLDEN_HEALTH, {
      requiredScope: 'connector:health:read',
      headers: { ...headersFor(GOLDEN_HEALTH), 'x-cloudgull-key-id': 'someone-else' },
    }),
    'INVALID_SERVICE_CREDENTIAL',
    401
  );
  await expectConnectorError(
    verify(GOLDEN_HEALTH, {
      requiredScope: 'connector:health:read',
      headers: { ...headersFor(GOLDEN_HEALTH), authorization: 'Bearer wrong-token' },
    }),
    'INVALID_SERVICE_CREDENTIAL',
    401
  );

  // 4. Scope is checked after the credential and before the signature. The
  //    signature is unaffected (scopes are not part of the preimage), so a
  //    health-only credential still carries a valid signature and is refused on
  //    scope alone — which is exactly what the server must do.
  await expectConnectorError(
    verify(GOLDEN_HEALTH, {
      requiredScope: 'connector:products:write',
      credentials: [{ ...GOLDEN_CREDENTIAL, scopes: ['connector:health:read'] }],
    }),
    'INSUFFICIENT_SCOPE',
    403
  );

  // 5. Tampered body / nonce / signature.
  await expectConnectorError(
    verifyConnectorRequest({
      headers: headersFor(GOLDEN_PRODUCT),
      method: GOLDEN_PRODUCT.method,
      publicPath: GOLDEN_PRODUCT.path,
      rawBody: GOLDEN_PRODUCT.body.replace('"revision":3', '"revision":4'),
      requiredScope: 'connector:products:write',
      credentials: [GOLDEN_CREDENTIAL],
      claimNonce: memoryNonceClaimer(),
      now: Number(GOLDEN_TIMESTAMP),
    }),
    'INVALID_REQUEST_SIGNATURE',
    401
  );
  await expectConnectorError(
    verify(GOLDEN_PRODUCT, {
      headers: { ...headersFor(GOLDEN_PRODUCT), 'x-cloudgull-signature': 'v1=deadbeef' },
    }),
    'INVALID_REQUEST_SIGNATURE',
    401
  );

  // 6. Replay is last: an unauthenticated caller cannot burn a nonce.
  const claimNonce = memoryNonceClaimer();
  await verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read', claimNonce });
  await expectConnectorError(
    verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read', claimNonce }),
    'REPLAY_DETECTED',
    409
  );
});

test('credential rotation accepts current and next, and a retired key stops working', async () => {
  const current = { ...GOLDEN_CREDENTIAL, keyId: 'current', version: '1' };
  const next = { ...GOLDEN_CREDENTIAL, keyId: 'next', token: 'next-token', signingSecret: 'next-signing-secret', version: '2' };
  const credentials = [current, next];

  const viaCurrent = await verify(GOLDEN_HEALTH, {
    requiredScope: 'connector:health:read',
    credentials,
    credential: current,
  });
  assert.equal(viaCurrent.keyId, 'current');

  const viaNext = await verify(GOLDEN_HEALTH, {
    requiredScope: 'connector:health:read',
    credentials,
    credential: next,
  });
  assert.equal(viaNext.keyId, 'next');
  assert.equal(viaNext.keyVersion, '2');

  // The same key id at a different version must not be interchangeable.
  await expectConnectorError(
    verify(GOLDEN_HEALTH, {
      requiredScope: 'connector:health:read',
      credentials,
      headers: { ...headersFor(GOLDEN_HEALTH, next), 'x-cloudgull-key-version': '1' },
    }),
    'INVALID_SERVICE_CREDENTIAL',
    401
  );

  // Revoking current leaves next working.
  const afterRevoke = [next];
  await expectConnectorError(
    verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read', credentials: afterRevoke, credential: current }),
    'INVALID_SERVICE_CREDENTIAL',
    401
  );
  await verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read', credentials: afterRevoke, credential: next });
});

test('expired and not-yet-valid credentials are rejected', async () => {
  const now = Number(GOLDEN_TIMESTAMP);
  const expired = { ...GOLDEN_CREDENTIAL, expiresAt: now - 1 };
  const future = { ...GOLDEN_CREDENTIAL, notBefore: now + 1 };
  await expectConnectorError(
    verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read', credentials: [expired] }),
    'INVALID_SERVICE_CREDENTIAL',
    401
  );
  await expectConnectorError(
    verify(GOLDEN_HEALTH, { requiredScope: 'connector:health:read', credentials: [future] }),
    'INVALID_SERVICE_CREDENTIAL',
    401
  );
  await verify(GOLDEN_HEALTH, {
    requiredScope: 'connector:health:read',
    credentials: [{ ...GOLDEN_CREDENTIAL, notBefore: now - 1, expiresAt: now + 1 }],
  });
});

test('credential environment contract is symmetric with CloudGull and fails closed', () => {
  const environment = {
    PAWSHOP_CONNECTOR_KEY_ID: 'k1',
    PAWSHOP_CONNECTOR_SERVICE_TOKEN: 't1',
    PAWSHOP_CONNECTOR_SIGNING_SECRET: 's1',
    PAWSHOP_CONNECTOR_SCOPES: 'connector:health:read,connector:products:write',
    PAWSHOP_CONNECTOR_KEY_VERSION: '1',
    PAWSHOP_CONNECTOR_NOT_BEFORE: '2026-01-01T00:00:00.000Z',
    PAWSHOP_CONNECTOR_EXPIRES_AT: '2027-01-01T00:00:00.000Z',
    PAWSHOP_CONNECTOR_KEY_ID_NEXT: 'k2',
    PAWSHOP_CONNECTOR_SERVICE_TOKEN_NEXT: 't2',
    PAWSHOP_CONNECTOR_SIGNING_SECRET_NEXT: 's2',
    PAWSHOP_CONNECTOR_SCOPES_NEXT: 'connector:products:write',
    PAWSHOP_CONNECTOR_KEY_VERSION_NEXT: '2',
  };
  const credentials = readConnectorCredentials(environment);
  assert.equal(credentials.length, 2);
  assert.deepEqual(credentials.map((credential) => [credential.keyId, credential.version]), [['k1', '1'], ['k2', '2']]);
  assert.deepEqual(credentials[0].scopes, ['connector:health:read', 'connector:products:write']);
  assert.equal(credentials[1].notBefore, undefined);

  assert.throws(() => readConnectorCredentials({}), /not configured/);
  assert.throws(
    () => readConnectorCredentials({ PAWSHOP_CONNECTOR_KEY_ID: 'k1' }),
    /incomplete/
  );
  assert.throws(
    () => readConnectorCredentials({
      PAWSHOP_CONNECTOR_KEY_ID: 'k1',
      PAWSHOP_CONNECTOR_SERVICE_TOKEN: 't1',
      PAWSHOP_CONNECTOR_SIGNING_SECRET: 's1',
      PAWSHOP_CONNECTOR_SCOPES: 'connector:orders:read',
    }),
    /Unknown PawShop Connector scope/
  );
  assert.throws(
    () => readConnectorCredentials({
      PAWSHOP_CONNECTOR_KEY_ID: 'k1',
      PAWSHOP_CONNECTOR_SERVICE_TOKEN: 't1',
      PAWSHOP_CONNECTOR_SIGNING_SECRET: 's1',
    }),
    /has no scope/
  );
});

const TRAVEL_PRODUCT = {
  source: { system: 'cloudgull', productId: 'CG-1001', revision: 3 },
  product: {
    title: 'Lightweight pet travel backpack',
    subtitle: 'Short commutes and weekend trips',
    status: 'active',
    category: { name: 'Travel' },
    variants: [
      { sourceVariantId: 'CG-1001-variant-1', sku: 'CG-1001-1', title: 'Small', price: { amount: 79, currency: 'USD' }, inventoryQuantity: 8 },
      { sourceVariantId: 'CG-1001-variant-2', sku: 'CG-1001-2', title: 'Large', price: { amount: 99.5, currency: 'USD' }, inventoryQuantity: 3 },
    ],
    media: [
      { sourceMediaId: 'CG-M-2', url: 'https://media.pawlivora.com/products/x/02.png', alt: 'Side view', primary: false, position: 2 },
      { sourceMediaId: 'CG-M-1', url: 'https://media.pawlivora.com/products/x/01.png', alt: 'Front view', primary: true, position: 1 },
    ],
  },
};

const serialize = (value) => JSON.stringify(value);

test('a valid CloudGull product request is normalised, not altered', () => {
  const dto = parseProductUpsertRequest(serialize(TRAVEL_PRODUCT), 'CG-1001');
  assert.equal(dto.source.productId, 'CG-1001');
  assert.equal(dto.source.revision, 3);
  assert.equal(dto.product.connectorStatus, 'active');
  assert.equal(dto.product.categoryName, 'Travel');
  assert.equal(dto.product.variants.length, 2);
  assert.equal(dto.product.variants[1].priceAmount, 99.5);
  // Media arrives sorted by position regardless of the order the caller used.
  assert.deepEqual(dto.product.media.map((entry) => entry.sourceMediaId), ['CG-M-1', 'CG-M-2']);
});

test('contract violations are 422, because the contract says they must be fixed not retried', () => {
  const cases = [
    ['not JSON', 'not-json', /valid JSON/],
    ['path/body product id mismatch', serialize({ ...TRAVEL_PRODUCT, source: { ...TRAVEL_PRODUCT.source, productId: 'CG-9999' } }), /must match the product id in the request path/],
    ['wrong system', serialize({ ...TRAVEL_PRODUCT, source: { ...TRAVEL_PRODUCT.source, system: 'shopify' } }), /source\.system/],
    ['negative revision', serialize({ ...TRAVEL_PRODUCT, source: { ...TRAVEL_PRODUCT.source, revision: -1 } }), /source\.revision/],
    ['unknown status', serialize({ ...TRAVEL_PRODUCT, product: { ...TRAVEL_PRODUCT.product, status: 'published' } }), /product\.status/],
    ['empty title', serialize({ ...TRAVEL_PRODUCT, product: { ...TRAVEL_PRODUCT.product, title: '   ' } }), /product\.title/],
    ['no variants', serialize({ ...TRAVEL_PRODUCT, product: { ...TRAVEL_PRODUCT.product, variants: [] } }), /non-empty array/],
    ['duplicate sku', serialize({
      ...TRAVEL_PRODUCT,
      product: {
        ...TRAVEL_PRODUCT.product,
        variants: [TRAVEL_PRODUCT.product.variants[0], { ...TRAVEL_PRODUCT.product.variants[1], sku: 'CG-1001-1' }],
      },
    }), /sku must be unique/],
    ['duplicate sourceVariantId', serialize({
      ...TRAVEL_PRODUCT,
      product: {
        ...TRAVEL_PRODUCT.product,
        variants: [TRAVEL_PRODUCT.product.variants[0], { ...TRAVEL_PRODUCT.product.variants[1], sourceVariantId: 'CG-1001-variant-1' }],
      },
    }), /sourceVariantId must be unique/],
    ['non-USD currency', serialize({
      ...TRAVEL_PRODUCT,
      product: {
        ...TRAVEL_PRODUCT.product,
        variants: [{ ...TRAVEL_PRODUCT.product.variants[0], price: { amount: 79, currency: 'CNY' } }],
      },
    }), /must be USD/],
    ['sub-cent price', serialize({
      ...TRAVEL_PRODUCT,
      product: {
        ...TRAVEL_PRODUCT.product,
        variants: [{ ...TRAVEL_PRODUCT.product.variants[0], price: { amount: 79.999, currency: 'USD' } }],
      },
    }), /two decimal places/],
    ['zero price', serialize({
      ...TRAVEL_PRODUCT,
      product: {
        ...TRAVEL_PRODUCT.product,
        variants: [{ ...TRAVEL_PRODUCT.product.variants[0], price: { amount: 0, currency: 'USD' } }],
      },
    }), /greater than zero/],
    ['negative inventory', serialize({
      ...TRAVEL_PRODUCT,
      product: {
        ...TRAVEL_PRODUCT.product,
        variants: [{ ...TRAVEL_PRODUCT.product.variants[0], inventoryQuantity: -1 }],
      },
    }), /inventoryQuantity/],
    ['media host not approved', serialize({
      ...TRAVEL_PRODUCT,
      product: {
        ...TRAVEL_PRODUCT.product,
        media: [{ sourceMediaId: 'CG-M-9', url: 'https://evil.example.com/x.png', alt: '', primary: true, position: 1 }],
      },
    }), /not an approved media host/],
    ['non-HTTPS media', serialize({
      ...TRAVEL_PRODUCT,
      product: {
        ...TRAVEL_PRODUCT.product,
        media: [{ sourceMediaId: 'CG-M-9', url: 'http://media.pawlivora.com/x.png', alt: '', primary: true, position: 1 }],
      },
    }), /must use HTTPS/],
    ['two primaries', serialize({
      ...TRAVEL_PRODUCT,
      product: {
        ...TRAVEL_PRODUCT.product,
        media: [
          { sourceMediaId: 'CG-M-1', url: 'https://media.pawlivora.com/products/x/01.png', alt: '', primary: true, position: 1 },
          { sourceMediaId: 'CG-M-2', url: 'https://media.pawlivora.com/products/x/02.png', alt: '', primary: true, position: 2 },
        ],
      },
    }), /at most one entry as primary/],
  ];

  for (const [label, body, pattern] of cases) {
    assert.throws(
      () => parseProductUpsertRequest(body, 'CG-1001'),
      (error) => {
        assert.ok(error instanceof ConnectorRequestError, `${label}: expected ConnectorRequestError`);
        assert.equal(error.code, 'CONTRACT_VALIDATION_FAILED', `${label}: wrong code`);
        assert.equal(error.status, 422, `${label}: wrong status`);
        assert.equal(error.retryable, false, `${label}: 422 must not be retryable`);
        assert.match(error.message, pattern, `${label}: unexpected message ${error.message}`);
        return true;
      },
      label
    );
  }
});

test('a URL carrying host-spoofing userinfo cannot pass the media allowlist', () => {
  assert.throws(
    () => parseProductUpsertRequest(serialize({
      ...TRAVEL_PRODUCT,
      product: {
        ...TRAVEL_PRODUCT.product,
        media: [{
          sourceMediaId: 'CG-M-9',
          url: 'https://media.pawlivora.com@evil.example.com/x.png',
          alt: '',
          primary: true,
          position: 1,
        }],
      },
    }), 'CG-1001'),
    (error) => error.code === 'CONTRACT_VALIDATION_FAILED' && /not an approved media host/.test(error.message)
  );
});

test('the create payload satisfies the Medusa product workflow contract', () => {
  const dto = parseProductUpsertRequest(serialize(TRAVEL_PRODUCT), 'CG-1001');
  const input = buildCreateInput(dto, { handle: 'lightweight-pet-travel-backpack', categoryId: 'pcat_1', salesChannelId: 'sc_1' });

  // createProductsWorkflow rejects a product with no options outright.
  assert.deepEqual(input.options, [{ title: 'Source Variant', values: ['CG-1001-variant-1', 'CG-1001-variant-2'] }]);
  // Every variant must map the single option, and each to a distinct value.
  assert.deepEqual(input.variants.map((variant) => variant.options), [
    { 'Source Variant': 'CG-1001-variant-1' },
    { 'Source Variant': 'CG-1001-variant-2' },
  ]);
  assert.deepEqual(input.variants.map((variant) => variant.prices), [
    [{ currency_code: 'usd', amount: 79 }],
    [{ currency_code: 'usd', amount: 99.5 }],
  ]);
  assert.deepEqual(input.variants.map((variant) => variant.manage_inventory), [false, false]);
  assert.equal(input.status, 'published');
  assert.equal(input.thumbnail, 'https://media.pawlivora.com/products/x/01.png');
  assert.deepEqual(input.images.map((image) => image.url), [
    'https://media.pawlivora.com/products/x/01.png',
    'https://media.pawlivora.com/products/x/02.png',
  ]);
  assert.deepEqual(input.category_ids, ['pcat_1']);
  assert.deepEqual(input.sales_channels, [{ id: 'sc_1' }]);

  // The inventory quantity the contract sends is preserved, not dropped.
  assert.deepEqual(input.metadata.cloudgull_connector.pending_inventory, [
    { source_variant_id: 'CG-1001-variant-1', sku: 'CG-1001-1', inventory_quantity: 8 },
    { source_variant_id: 'CG-1001-variant-2', sku: 'CG-1001-2', inventory_quantity: 3 },
  ]);
  assert.deepEqual(input.metadata.cloudgull_connector.media.map((entry) => entry.source_media_id), ['CG-M-1', 'CG-M-2']);
  assert.equal(input.metadata.cloudgull_connector.connector_status, 'active');
});

test('status mapping keeps archived distinguishable from draft', () => {
  const build = (status) => buildCreateInput(
    parseProductUpsertRequest(serialize({
      ...TRAVEL_PRODUCT,
      product: { ...TRAVEL_PRODUCT.product, status },
    }), 'CG-1001'),
    { handle: 'h' }
  );
  assert.equal(build('active').status, 'published');
  assert.equal(build('draft').status, 'draft');
  assert.equal(build('archived').status, 'draft');
  assert.equal(build('archived').metadata.cloudgull_connector.connector_status, 'archived');
  assert.equal(build('draft').metadata.cloudgull_connector.connector_status, 'draft');
});

test('the update payload follows the stored variant order and preserves the handle', () => {
  const dto = parseProductUpsertRequest(serialize(TRAVEL_PRODUCT), 'CG-1001');
  const existing = {
    id: 'prod_1',
    handle: 'lightweight-pet-travel-backpack',
    metadata: { import_contract: 'pawshop-local-v2' },
    variants: [
      { id: 'variant_1', sku: 'CG-1001-1', title: 'Small', metadata: { cloudgull_source_variant_id: 'CG-1001-variant-1' } },
      { id: 'variant_2', sku: 'CG-1001-2', title: 'Large', metadata: { cloudgull_source_variant_id: 'CG-1001-variant-2' } },
    ],
  };
  const update = buildUpdateInput(dto, { existing });

  assert.deepEqual(update.variants.map((variant) => variant.id), ['variant_1', 'variant_2']);
  assert.deepEqual(update.variants.map((variant) => variant.prices[0].amount), [79, 99.5]);
  assert.equal(update.status, 'published');
  assert.equal(update.title, 'Lightweight pet travel backpack');
  // Unrelated metadata written by other tooling survives.
  assert.equal(update.metadata.import_contract, 'pawshop-local-v2');
  // The handle is never recomputed on update, so a retitle cannot move the URL.
  assert.equal(Object.prototype.hasOwnProperty.call(update, 'handle'), false);
});

test('an update may retitle a variant without touching the option set', () => {
  const renamed = {
    ...TRAVEL_PRODUCT,
    source: { ...TRAVEL_PRODUCT.source, revision: 4 },
    product: {
      ...TRAVEL_PRODUCT.product,
      variants: [
        { ...TRAVEL_PRODUCT.product.variants[0], title: 'Compact' },
        { ...TRAVEL_PRODUCT.product.variants[1], title: 'Roomy' },
      ],
    },
  };
  const dto = parseProductUpsertRequest(serialize(renamed), 'CG-1001');
  const update = buildUpdateInput(dto, {
    existing: {
      id: 'prod_1',
      metadata: {},
      variants: [
        { id: 'variant_1', sku: 'CG-1001-1', metadata: { cloudgull_source_variant_id: 'CG-1001-variant-1' } },
        { id: 'variant_2', sku: 'CG-1001-2', metadata: { cloudgull_source_variant_id: 'CG-1001-variant-2' } },
      ],
    },
  });
  assert.deepEqual(update.variants.map((variant) => variant.title), ['Compact', 'Roomy']);
  assert.equal(Object.prototype.hasOwnProperty.call(update, 'options'), false);
});

test('a variant-set change is refused loudly instead of being dropped', () => {
  const dto = parseProductUpsertRequest(serialize(TRAVEL_PRODUCT), 'CG-1001');
  const existing = {
    id: 'prod_1',
    metadata: {},
    variants: [{ id: 'variant_1', sku: 'CG-1001-1', metadata: { cloudgull_source_variant_id: 'CG-1001-variant-1' } }],
  };
  assert.throws(
    () => buildUpdateInput(dto, { existing }),
    (error) => {
      assert.equal(error.code, 'CONTRACT_VALIDATION_FAILED');
      assert.deepEqual(error.details.addedSkus, ['CG-1001-2']);
      assert.deepEqual(error.details.removedSkus, []);
      return true;
    }
  );

  assert.throws(
    () => buildUpdateInput(
      parseProductUpsertRequest(serialize({
        ...TRAVEL_PRODUCT,
        product: {
          ...TRAVEL_PRODUCT.product,
          variants: [{ ...TRAVEL_PRODUCT.product.variants[0], sourceVariantId: 'CG-1001-variant-9' }],
        },
      }), 'CG-1001'),
      { existing }
    ),
    (error) => {
      assert.equal(error.code, 'CONTRACT_VALIDATION_FAILED');
      assert.equal(error.details.storedSourceVariantId, 'CG-1001-variant-1');
      return true;
    }
  );
});

test('handles are readable, stable in shape, and de-duplicated deterministically', () => {
  const taken = new Set(['lightweight-pet-travel-backpack']);
  const handle = handleForProduct({
    title: 'Lightweight pet travel backpack',
    sourceProductId: 'CG-1001',
    handleTaken: (candidate) => taken.has(candidate),
  });
  assert.match(handle, /^lightweight-pet-travel-backpack-[a-f0-9]{6}$/);
  assert.equal(
    handle,
    handleForProduct({
      title: 'Lightweight pet travel backpack',
      sourceProductId: 'CG-1001',
      handleTaken: (candidate) => taken.has(candidate),
    })
  );
  assert.equal(
    handleForProduct({ title: 'Lightweight pet travel backpack', sourceProductId: 'CG-1001', handleTaken: () => false }),
    'lightweight-pet-travel-backpack'
  );
  // A title with no usable ASCII still yields a valid Medusa handle.
  assert.equal(
    handleForProduct({ title: '宠物背包', sourceProductId: 'CG-1001', handleTaken: () => false }),
    'product-cg-1001'
  );
});

test('the external version keeps the ps-r<revision> shape CloudGull stores', () => {
  assert.equal(externalVersionFor(3), 'ps-r3');
  assert.equal(externalVersionFor(0), 'ps-r0');
});
