'use strict';

// Translation layer for `PUT /api/connector/v1/products/{sourceProductId}`.
//
// Two jobs, deliberately separated:
//   1. Validate the neutral CloudGull DTO and turn it into a flat, fully
//      normalised shape. Every rejection is CONTRACT_VALIDATION_FAILED (422),
//      because the contract says a 422 must be fixed by the caller, never
//      retried.
//   2. Map that neutral shape onto a Medusa product payload.
//
// CloudGull must never see Medusa vocabulary, and Medusa must never see raw
// CloudGull input: everything Medusa-bound leaves this file already validated,
// already namespaced, already bounded.
//
// Design notes that matter for idempotent updates:
//
//   * Variants are keyed by (sourceVariantId, sku), not by title. The Medusa
//     product option uses the sourceVariantId as its value, which keeps the
//     option set stable across renames — and the storefront renders
//     `variant.title`, never the option value, so the label stays the
//     customer-visible name.
//   * `manage_inventory` is false. Real stock levels belong to the future
//     Inventory endpoint (`PATCH /inventory/{sourceVariantId}`), which the
//     contract explicitly leaves unimplemented. The requested quantity is
//     preserved in metadata rather than dropped, and reported in the audit.
//   * Medusa has no `archived` product status, so `archived` maps to a draft
//     plus an explicit `connector_status` marker in metadata instead of being
//     silently rounded to `draft`.

const { createHash } = require('node:crypto');
const { ConnectorRequestError } = require('./connector-errors.cjs');

const CONNECTOR_SYSTEM = 'cloudgull';
const CONNECTOR_STATUS_VALUES = Object.freeze(['active', 'draft', 'archived']);
const MEDUSA_STATUS_BY_CONNECTOR_STATUS = Object.freeze({
  active: 'published',
  draft: 'draft',
  archived: 'draft',
});

// CloudGull's connector contract is USD-only (its own type pins the currency).
const CONNECTOR_CURRENCY = 'USD';
const MEDUSA_CURRENCY = 'usd';
const CONNECTOR_OPTION_TITLE = 'Source Variant';

const MAX_VARIANTS = 100;
const MAX_MEDIA = 100;
const MAX_TITLE_LENGTH = 255;
const MAX_SUBTITLE_LENGTH = 255;
const MAX_CATEGORY_NAME_LENGTH = 100;
const MAX_SKU_LENGTH = 100;
const MAX_SOURCE_ID_LENGTH = 128;
const MAX_ALT_LENGTH = 255;
const MAX_PRICE_AMOUNT = 1_000_000;
const MAX_INVENTORY_QUANTITY = 1_000_000;

// Only image URLs from an approved host are accepted. Without this the
// connector would happily let the calling service point a public product page at
// any origin it liked. The default list mirrors the storefront's own
// `config.imageHosts`, and PAWSHOP_CONNECTOR_MEDIA_HOSTS overrides it so the
// host policy can be settled at go-live without a code change.
const DEFAULT_MEDIA_HOSTS = Object.freeze([
  'media.pawlivora.com',
  'pawlivora-products-us-west-1.oss-us-west-1.aliyuncs.com',
]);

function mediaHostAllowlist(environment = process.env) {
  const configured = String(environment.PAWSHOP_CONNECTOR_MEDIA_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return configured.length ? configured : [...DEFAULT_MEDIA_HOSTS];
}

function fail(message, details) {
  throw new ConnectorRequestError('CONTRACT_VALIDATION_FAILED', message, { details });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value, label, { maxLength, allowEmpty = false }) {
  if (typeof value !== 'string') fail(`${label} must be a string.`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) fail(`${label} must not be empty.`);
  if (trimmed.length > maxLength) fail(`${label} must be at most ${maxLength} characters.`);
  return trimmed;
}

function readIdentifier(value, label) {
  const text = readString(value, label, { maxLength: MAX_SOURCE_ID_LENGTH });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    fail(`${label} must use only letters, digits, dot, underscore, colon or hyphen.`);
  }
  return text;
}

function readInteger(value, label, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function readPriceAmount(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a finite number.`);
  if (value <= 0) fail(`${label} must be greater than zero.`);
  if (value > MAX_PRICE_AMOUNT) fail(`${label} must be at most ${MAX_PRICE_AMOUNT}.`);
  // Medusa stores the amount as a decimal (29.9 for USD 29.90), so the value
  // travels unchanged. Rejecting sub-cent precision keeps a float artefact from
  // reaching the database.
  if (Number(value.toFixed(2)) !== value) {
    fail(`${label} must not have more than two decimal places.`);
  }
  return value;
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} must be unique; ${value} is repeated.`);
    seen.add(value);
  }
}

function validateMediaEntry(raw, index, mediaHosts) {
  const label = `product.media[${index}]`;
  if (!isPlainObject(raw)) fail(`${label} must be an object.`);
  const sourceMediaId = readIdentifier(raw.sourceMediaId, `${label}.sourceMediaId`);

  const rawUrl = readString(raw.url, `${label}.url`, { maxLength: 2048 });
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    fail(`${label}.url must be an absolute URL.`);
  }
  if (parsed.protocol !== 'https:') fail(`${label}.url must use HTTPS.`);
  if (!mediaHosts.includes(parsed.hostname.toLowerCase())) {
    fail(
      `${label}.url host ${parsed.hostname} is not an approved media host.`,
      { approvedHosts: mediaHosts, hint: 'Set PAWSHOP_CONNECTOR_MEDIA_HOSTS to extend the allowlist.' }
    );
  }

  if (typeof raw.primary !== 'boolean') fail(`${label}.primary must be a boolean.`);

  return {
    sourceMediaId,
    url: parsed.toString(),
    alt: readString(raw.alt, `${label}.alt`, { maxLength: MAX_ALT_LENGTH, allowEmpty: true }),
    primary: raw.primary,
    position: readInteger(raw.position, `${label}.position`, { min: 0, max: 10_000 }),
  };
}

function validateVariant(raw, index) {
  const label = `product.variants[${index}]`;
  if (!isPlainObject(raw)) fail(`${label} must be an object.`);
  if (!isPlainObject(raw.price)) fail(`${label}.price must be an object.`);
  if (raw.price.currency !== CONNECTOR_CURRENCY) {
    fail(`${label}.price.currency must be ${CONNECTOR_CURRENCY}.`);
  }
  return {
    sourceVariantId: readIdentifier(raw.sourceVariantId, `${label}.sourceVariantId`),
    sku: readString(raw.sku, `${label}.sku`, { maxLength: MAX_SKU_LENGTH }),
    title: readString(raw.title, `${label}.title`, { maxLength: MAX_TITLE_LENGTH }),
    priceAmount: readPriceAmount(raw.price.amount, `${label}.price.amount`),
    inventoryQuantity: readInteger(raw.inventoryQuantity, `${label}.inventoryQuantity`, {
      min: 0,
      max: MAX_INVENTORY_QUANTITY,
    }),
  };
}

// Parses the raw JSON text. `rawBody` is the untouched request body (the
// signature covers exactly these bytes), so parsing is the first place the body
// is interpreted at all.
function parseProductUpsertRequest(rawBody, sourceProductIdFromPath, options = {}) {
  const mediaHosts = options.mediaHosts ?? mediaHostAllowlist();

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    fail('The request body must be valid JSON.');
  }
  if (!isPlainObject(parsedBody)) fail('The request body must be a JSON object.');

  const source = parsedBody.source;
  if (!isPlainObject(source)) fail('source must be an object.');
  if (source.system !== CONNECTOR_SYSTEM) fail(`source.system must be "${CONNECTOR_SYSTEM}".`);
  const sourceProductId = readIdentifier(source.productId, 'source.productId');
  if (sourceProductId !== sourceProductIdFromPath) {
    fail('source.productId must match the product id in the request path.', {
      pathProductId: sourceProductIdFromPath,
      bodyProductId: sourceProductId,
    });
  }
  const revision = readInteger(source.revision, 'source.revision', { min: 0, max: Number.MAX_SAFE_INTEGER });

  const product = parsedBody.product;
  if (!isPlainObject(product)) fail('product must be an object.');
  if (!CONNECTOR_STATUS_VALUES.includes(product.status)) {
    fail(`product.status must be one of ${CONNECTOR_STATUS_VALUES.join(', ')}.`);
  }

  const category = product.category;
  if (!isPlainObject(category)) fail('product.category must be an object.');
  const categoryName = readString(category.name, 'product.category.name', {
    maxLength: MAX_CATEGORY_NAME_LENGTH,
  });

  if (!Array.isArray(product.variants) || product.variants.length === 0) {
    fail('product.variants must be a non-empty array.');
  }
  if (product.variants.length > MAX_VARIANTS) {
    fail(`product.variants must contain at most ${MAX_VARIANTS} entries.`);
  }
  const variants = product.variants.map(validateVariant);
  assertUnique(variants.map((variant) => variant.sourceVariantId), 'product.variants[].sourceVariantId');
  assertUnique(variants.map((variant) => variant.sku), 'product.variants[].sku');

  if (!Array.isArray(product.media)) fail('product.media must be an array.');
  if (product.media.length > MAX_MEDIA) fail(`product.media must contain at most ${MAX_MEDIA} entries.`);
  const media = product.media.map((entry, index) => validateMediaEntry(entry, index, mediaHosts));
  assertUnique(media.map((entry) => entry.sourceMediaId), 'product.media[].sourceMediaId');
  assertUnique(media.map((entry) => entry.url), 'product.media[].url');
  if (media.filter((entry) => entry.primary).length > 1) {
    fail('product.media must mark at most one entry as primary.');
  }

  return {
    source: { system: CONNECTOR_SYSTEM, productId: sourceProductId, revision },
    product: {
      title: readString(product.title, 'product.title', { maxLength: MAX_TITLE_LENGTH }),
      subtitle: readString(product.subtitle, 'product.subtitle', {
        maxLength: MAX_SUBTITLE_LENGTH,
        allowEmpty: true,
      }),
      connectorStatus: product.status,
      categoryName,
      variants,
      media: media.slice().sort((left, right) => left.position - right.position),
    },
  };
}

function medusaStatusFor(connectorStatus) {
  const status = MEDUSA_STATUS_BY_CONNECTOR_STATUS[connectorStatus];
  if (!status) fail(`product.status must be one of ${CONNECTOR_STATUS_VALUES.join(', ')}.`);
  return status;
}

function slugify(value) {
  const slug = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug;
}

// Medusa needs a unique handle. The handle is derived from the title so the
// public URL stays readable, but it is computed once and then persisted in the
// connector's own mapping table: a later retitle must not move the product URL.
// Only a genuine collision with an unrelated product pulls in a deterministic
// suffix built from the stable CloudGull product id.
function handleForProduct({ title, sourceProductId, handleTaken }) {
  const slug = slugify(title);
  const base = slug || `product-${sourceProductId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  if (!handleTaken(base)) return base;
  const suffix = createHash('sha256').update(sourceProductId).digest('hex').slice(0, 6);
  let candidate = `${base}-${suffix}`;
  let counter = 1;
  while (handleTaken(candidate)) {
    candidate = `${base}-${suffix}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function thumbnailFor(media) {
  const primary = media.find((entry) => entry.primary);
  if (primary) return primary.url;
  return media.length ? media[0].url : null;
}

// Metadata is the connector's own record inside the product. It never carries a
// secret, and it keeps the parts Medusa has no column for (the CloudGull media
// ids, alt text, and the inventory quantity that the future Inventory endpoint
// will apply) from being silently dropped.
function connectorMetadata(dto, previousMetadata) {
  const { source, product } = dto;
  return {
    ...(isPlainObject(previousMetadata) ? previousMetadata : {}),
    cloudgull_connector: {
      system: CONNECTOR_SYSTEM,
      source_product_id: source.productId,
      source_revision: source.revision,
      connector_status: product.connectorStatus,
      category_name: product.categoryName,
      media: product.media.map((entry) => ({
        source_media_id: entry.sourceMediaId,
        url: entry.url,
        alt: entry.alt,
        primary: entry.primary,
        position: entry.position,
      })),
      pending_inventory: product.variants.map((variant) => ({
        source_variant_id: variant.sourceVariantId,
        sku: variant.sku,
        inventory_quantity: variant.inventoryQuantity,
      })),
    },
  };
}

function variantPrices(variant) {
  return [{ currency_code: MEDUSA_CURRENCY, amount: variant.priceAmount }];
}

// Each variant owns exactly one option value: its own stable sourceVariantId.
function variantOptionMap(variant) {
  return { [CONNECTOR_OPTION_TITLE]: variant.sourceVariantId };
}

function buildCreateInput(dto, { handle, categoryId, salesChannelId }) {
  const images = dto.product.media.map((entry) => ({ url: entry.url }));
  return {
    title: dto.product.title,
    subtitle: dto.product.subtitle || null,
    handle,
    status: medusaStatusFor(dto.product.connectorStatus),
    thumbnail: thumbnailFor(dto.product.media),
    images,
    ...(categoryId ? { category_ids: [categoryId] } : {}),
    ...(salesChannelId ? { sales_channels: [{ id: salesChannelId }] } : {}),
    options: [{ title: CONNECTOR_OPTION_TITLE, values: dto.product.variants.map((v) => v.sourceVariantId) }],
    variants: dto.product.variants.map((variant) => ({
      title: variant.title,
      sku: variant.sku,
      options: variantOptionMap(variant),
      prices: variantPrices(variant),
      manage_inventory: false,
      allow_backorder: false,
      metadata: {
        cloudgull_source_variant_id: variant.sourceVariantId,
        cloudgull_inventory_quantity: variant.inventoryQuantity,
      },
    })),
    metadata: connectorMetadata(dto, null),
  };
}

// Returns the update payload, or throws a 422 that names the deferred
// capability. Adding, removing or re-keying a variant would require touching the
// product's option values, which is a product-structure change the V1.1 contract
// does not define yet (the contract itself defers Inventory to a later
// endpoint). Failing loudly beats silently dropping the caller's variant.
function buildUpdateInput(dto, { existing }) {
  const existingBySku = new Map(existing.variants.map((variant) => [variant.sku, variant]));

  const desiredSkus = new Set(dto.product.variants.map((variant) => variant.sku));
  const added = dto.product.variants.filter((variant) => !existingBySku.has(variant.sku)).map((v) => v.sku);
  const removed = existing.variants.filter((variant) => !desiredSkus.has(variant.sku)).map((v) => v.sku);
  if (added.length || removed.length) {
    fail('Changing the variant set is not supported by this connector version.', {
      addedSkus: added,
      removedSkus: removed,
      deferredTo: 'the Inventory / variant-structure endpoint that the V1.1 contract leaves unimplemented',
    });
  }

  // `updateProductsWorkflow` binds incoming variants to existing ones by
  // position, so the payload must follow the product's stored variant order.
  const variants = existing.variants.map((existingVariant) => {
    const desired = dto.product.variants.find((variant) => variant.sku === existingVariant.sku);
    const storedSourceVariantId = existingVariant.metadata?.cloudgull_source_variant_id;
    if (storedSourceVariantId && storedSourceVariantId !== desired.sourceVariantId) {
      fail('A variant SKU is already linked to a different CloudGull variant id.', {
        sku: existingVariant.sku,
        storedSourceVariantId,
        incomingSourceVariantId: desired.sourceVariantId,
      });
    }
    return {
      id: existingVariant.id,
      title: desired.title,
      sku: desired.sku,
      prices: variantPrices(desired),
      metadata: {
        ...(isPlainObject(existingVariant.metadata) ? existingVariant.metadata : {}),
        cloudgull_source_variant_id: desired.sourceVariantId,
        cloudgull_inventory_quantity: desired.inventoryQuantity,
      },
    };
  });

  const images = dto.product.media.map((entry) => ({ url: entry.url }));
  return {
    title: dto.product.title,
    subtitle: dto.product.subtitle || null,
    status: medusaStatusFor(dto.product.connectorStatus),
    thumbnail: thumbnailFor(dto.product.media),
    images,
    variants,
    metadata: connectorMetadata(dto, existing.metadata),
  };
}

// `version` is part of the response contract: CloudGull stores it as the
// external revision and its own tests assert the `ps-r<n>` shape.
function externalVersionFor(revision) {
  return `ps-r${revision}`;
}

module.exports = {
  CONNECTOR_CURRENCY,
  CONNECTOR_OPTION_TITLE,
  CONNECTOR_STATUS_VALUES,
  CONNECTOR_SYSTEM,
  DEFAULT_MEDIA_HOSTS,
  buildCreateInput,
  buildUpdateInput,
  connectorMetadata,
  externalVersionFor,
  handleForProduct,
  mediaHostAllowlist,
  medusaStatusFor,
  parseProductUpsertRequest,
  slugify,
  thumbnailFor,
};
