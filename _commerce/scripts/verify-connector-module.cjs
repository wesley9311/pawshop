'use strict';
// Static contract check for the PawShop Connector module.
//
// WHY THIS EXISTS
// `MedusaService` generates its CRUD methods from the model names when the class
// is created. The connector is reached through `req.scope.resolve(...)`, which is
// untyped, so a mistyped generated method name is a runtime failure that neither
// TypeScript nor the build would catch. This script asserts the generated surface
// really is what the connector code calls — without needing a database.
//
// It runs against COMPILED output, so it checks the same artefact the host loads.
//
// USAGE
//   # production-shaped: verify what the build produced
//   node scripts/verify-connector-module.cjs .medusa/server
//
//   # offline acceptance (no database, no full build):
//   node node_modules/typescript/bin/tsc --outDir /tmp/pawshop-connector-build
//   node scripts/verify-connector-module.cjs /tmp/pawshop-connector-build
//
// Exit code 0 means the module's method surface matches the connector code.

const { join, resolve } = require('node:path');

const compiledRoot = resolve(process.argv[2] || '.medusa/server');
const servicePath = join(compiledRoot, 'src', 'modules', 'pawshop-connector', 'service.js');

let PawshopConnectorService;
try {
  // eslint-disable-next-line import/no-dynamic-require
  const loaded = require(servicePath);
  PawshopConnectorService = loaded.default ?? loaded;
} catch (error) {
  process.stderr.write(`Could not load the compiled module service at ${servicePath}\n${error.message}\n`);
  process.exit(1);
}

const proto = PawshopConnectorService.prototype;

// MedusaService generates the CRUD methods on a base class, so they are inherited
// rather than own properties of this class. Walk the chain instead of looking at
// one level, or the check would silently pass on an empty surface.
const methodNames = new Set();
for (let cursor = proto; cursor && cursor !== Object.prototype; cursor = Object.getPrototypeOf(cursor)) {
  for (const name of Object.getOwnPropertyNames(cursor)) methodNames.add(name);
}
const has = (name) => typeof proto[name] === 'function' && methodNames.has(name);

// Every generated method the connector's own code calls.
const REQUIRED_GENERATED = [
  'createConnectorProductMappings',
  'listConnectorProductMappings',
  'updateConnectorProductMappings',
  'createConnectorIdempotencyRecords',
  'listConnectorIdempotencyRecords',
  'updateConnectorIdempotencyRecords',
  'deleteConnectorIdempotencyRecords',
  'createConnectorReplayNonces',
  'deleteConnectorReplayNonces',
  'createConnectorAuditEvents',
  'listConnectorAuditEvents',
];

// Methods the module defines itself.
const REQUIRED_CUSTOM = [
  'findProductMapping',
  'recordProductMapping',
  'findIdempotentRecord',
  'claimIdempotencyKey',
  'completeIdempotencyClaim',
  'releaseIdempotencyClaim',
  'claimNonce',
  'recordAudit',
  'listAudit',
  'pruneExpired',
];

// One generated CRUD group per model is the evidence that all four models are
// registered. `$modelObjects` is not a static in this Medusa version, so the
// generated method names are the reliable probe.
const REQUIRED_MODEL_METHODS = {
  ConnectorProductMapping: 'createConnectorProductMappings',
  ConnectorIdempotencyRecord: 'createConnectorIdempotencyRecords',
  ConnectorReplayNonce: 'createConnectorReplayNonces',
  ConnectorAuditEvent: 'createConnectorAuditEvents',
};

const missingGenerated = REQUIRED_GENERATED.filter((name) => !has(name));
const missingCustom = REQUIRED_CUSTOM.filter((name) => !has(name));
const missingModels = Object.entries(REQUIRED_MODEL_METHODS)
  .filter(([, method]) => !has(method))
  .map(([model]) => model);

const report = {
  compiledRoot,
  generatedMethods: [...methodNames]
    .filter((name) => !REQUIRED_CUSTOM.includes(name) && /^(create|list|listAndCount|retrieve|update|delete|softDelete|restore)/.test(name))
    .sort(),
  models: Object.keys(REQUIRED_MODEL_METHODS),
  missingGenerated,
  missingCustom,
  missingModels,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (missingGenerated.length || missingCustom.length || missingModels.length) {
  process.stderr.write('PawShop Connector module surface does NOT match the connector code.\n');
  process.exit(1);
}
process.stdout.write('PawShop Connector module surface OK.\n');
