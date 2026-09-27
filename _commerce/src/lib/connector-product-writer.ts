import type { MedusaRequest } from '@medusajs/framework/http'
import { createProductsWorkflow, updateProductsWorkflow } from '@medusajs/core-flows'
import { ContainerRegistrationKeys, MedusaError, Modules } from '@medusajs/framework/utils'
import { ConnectorRequestError } from './connector-errors.cjs'
import { buildCreateInput, buildUpdateInput, externalVersionFor, handleForProduct, slugify } from './connector-payload.cjs'

// Translates a validated CloudGull DTO into commerce writes.
//
// This is the only file that knows both vocabularies, and it is deliberately the
// last one: everything upstream works on the neutral DTO, and CloudGull never
// receives anything Medusa-shaped.
//
// The commerce engine stays swappable — CloudGull's contract does not mention
// Medusa, and nothing here leaks back out through the HTTP layer.

const PRODUCT_FIELDS = [
  'id',
  'handle',
  'status',
  'title',
  'subtitle',
  'thumbnail',
  'images.url',
  'metadata',
  'variants.id',
  'variants.sku',
  'variants.title',
  'variants.metadata',
]

// A commerce-engine rejection that the caller can actually fix is a contract
// violation (422, never retried); anything else is an upstream fault (500,
// retryable), because a half-applied write is worse than a retry.
function mapCommerceError(error: unknown): ConnectorRequestError {
  const type = (error as { type?: string })?.type
  const message = error instanceof Error ? error.message : String(error)
  if (
    type === MedusaError.Types.INVALID_DATA ||
    type === MedusaError.Types.DUPLICATE_ERROR ||
    type === MedusaError.Types.NOT_ALLOWED ||
    type === MedusaError.Types.INVALID_ARGUMENT
  ) {
    return new ConnectorRequestError('CONTRACT_VALIDATION_FAILED', message)
  }
  return new ConnectorRequestError('INTERNAL_ERROR', message)
}

async function ensureCategoryId(productService: any, categoryName: string): Promise<string | null> {
  const [existing] = await productService.listProductCategories({ name: categoryName }, { take: 1 })
  if (existing?.id) return existing.id
  try {
    const created = await productService.createProductCategories({
      name: categoryName,
      handle: slugify(categoryName) || undefined,
      is_active: true,
    })
    const category = Array.isArray(created) ? created[0] : created
    return category?.id ?? null
  } catch (error) {
    // Another request may have created the same category between the list and
    // the create; re-read before giving up.
    const [raced] = await productService.listProductCategories({ name: categoryName }, { take: 1 })
    if (raced?.id) return raced.id
    throw error
  }
}

async function defaultSalesChannelId(req: MedusaRequest): Promise<string | null> {
  try {
    const storeService = req.scope.resolve(Modules.STORE) as any
    const [store] = await storeService.listStores({}, { take: 1 })
    return store?.default_sales_channel_id ?? null
  } catch {
    // A store without a default channel still gets a valid product; it simply
    // will not be visible in a channel until one is linked.
    return null
  }
}

// The handle is derived from the title and then frozen in the mapping table, so
// the public URL survives a retitle. Only the first create has to pick one.
async function resolveHandle(
  req: MedusaRequest,
  dto: { source: { productId: string }; product: { title: string } }
): Promise<string> {
  const productService = req.scope.resolve(Modules.PRODUCT) as any
  const base = slugify(dto.product.title) || `product-${dto.source.productId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  const collisions: Array<{ handle?: string | null }> = await productService.listProducts(
    { handle: { $like: `${base}%` } },
    { select: ['handle'], take: 200 }
  )
  const taken = new Set(collisions.map((product) => product.handle))
  return handleForProduct({
    title: dto.product.title,
    sourceProductId: dto.source.productId,
    handleTaken: (candidate: string) => taken.has(candidate),
  })
}

export async function upsertConnectorProduct(
  req: MedusaRequest,
  dto: any,
  service: any
): Promise<{ productId: string; created: boolean }> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const productService = req.scope.resolve(Modules.PRODUCT) as any
  const mapping = await service.findProductMapping(dto.source.productId)

  if (mapping?.product_id) {
    const { data } = await query.graph({
      entity: 'product',
      fields: PRODUCT_FIELDS,
      filters: { id: mapping.product_id },
    })
    const existing = data?.[0]
    if (!existing) {
      // The mapped product was removed outside the connector. Creating a new one
      // silently would break the stable-external-id guarantee, so say so.
      throw new ConnectorRequestError('CONTRACT_VALIDATION_FAILED', 'The mapped PawShop product no longer exists.', {
        details: { sourceProductId: dto.source.productId, productId: mapping.product_id },
      })
    }

    const update = buildUpdateInput(dto, { existing })
    try {
      await updateProductsWorkflow(req.scope).run({ input: { selector: { id: existing.id }, update } })
    } catch (error) {
      throw mapCommerceError(error)
    }
    await service.recordProductMapping({
      sourceProductId: dto.source.productId,
      productId: existing.id,
      handle: existing.handle ?? null,
      revision: dto.source.revision,
      externalVersion: externalVersionFor(dto.source.revision),
    })
    return { productId: existing.id, created: false }
  }

  const [categoryId, salesChannelId, handle] = await Promise.all([
    ensureCategoryId(productService, dto.product.categoryName),
    defaultSalesChannelId(req),
    resolveHandle(req, dto),
  ])

  const input = buildCreateInput(dto, { handle, categoryId, salesChannelId })
  let created: { id?: string } | undefined
  try {
    const { result } = await createProductsWorkflow(req.scope).run({ input: { products: [input] } })
    created = result?.[0]
  } catch (error) {
    throw mapCommerceError(error)
  }
  if (!created?.id) {
    throw new ConnectorRequestError('INTERNAL_ERROR', 'The commerce engine did not return a product id.')
  }

  await service.recordProductMapping({
    sourceProductId: dto.source.productId,
    productId: created.id,
    handle,
    revision: dto.source.revision,
    externalVersion: externalVersionFor(dto.source.revision),
  })
  return { productId: created.id, created: true }
}
