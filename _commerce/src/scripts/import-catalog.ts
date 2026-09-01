import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, ProductStatus } from '@medusajs/framework/utils'
import { createProductsWorkflow } from '@medusajs/core-flows'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const HANDLE = 'large-corrugated-cardboard-cat-lounger'
const SKU = 'PAW-CSL-NG-001'

type SourceProduct = {
  id: number
  name: string
  price: number
  images: string[]
  description: string
  active: boolean
  variants: string[]
}

function validateSource(value: unknown): SourceProduct {
  if (!Array.isArray(value) || value.length !== 1) throw new Error('catalog.json must contain exactly one launch product.')
  const product = value[0] as SourceProduct
  if (product.id !== 1 || product.active !== true) throw new Error('Only reviewed source product id=1 may be imported.')
  if (product.price !== 29.9) throw new Error('Expected the reviewed USD price of 29.90.')
  if (!Array.isArray(product.images) || product.images.length !== 9) throw new Error('Expected exactly nine approved listing images.')
  if (!product.images.every(url => /^https:\/\/i\.ibb\.co\//.test(url))) throw new Error('An image URL is outside the approved host.')
  if (!product.name || !product.description || product.variants?.length !== 1) throw new Error('Required product copy or variant is missing.')
  return product
}

export default async function importCatalog({ container }: ExecArgs) {
  const sourcePath = resolve(process.cwd(), '..', 'catalog.json')
  const source = validateSource(JSON.parse(await readFile(sourcePath, 'utf8')))
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: existing } = await query.graph({
    entity: 'product',
    fields: [
      'id', 'handle', 'status', 'metadata', 'images.url',
      'variants.sku', 'variants.prices.amount', 'variants.prices.currency_code',
    ],
    filters: { handle: HANDLE },
  })

  if (existing.length > 1) throw new Error(`Duplicate backend products use handle ${HANDLE}.`)
  if (existing.length === 1) {
    const product = existing[0] as any
    const usd = product.variants?.[0]?.prices?.find((price: any) => price.currency_code === 'usd')
    if (
      product.status !== ProductStatus.DRAFT ||
      product.images?.length !== source.images.length ||
      !source.images.every(url => product.images.some((image: any) => image.url === url)) ||
      product.variants?.length !== 1 ||
      product.variants[0].sku !== SKU ||
      usd?.amount !== source.price ||
      product.metadata?.source_catalog_id !== source.id ||
      product.metadata?.reviewed_for_sale !== false
    ) {
      throw new Error('Existing catalog draft has drifted from the approved source; refusing to claim an idempotent import.')
    }
    console.log('Catalog draft already matches the approved source; import made no changes.')
    return
  }

  const { result } = await createProductsWorkflow(container).run({
    input: {
      products: [{
        title: source.name,
        handle: HANDLE,
        description: source.description,
        status: ProductStatus.DRAFT,
        thumbnail: source.images[0],
        images: source.images.map(url => ({ url })),
        options: [{ title: 'Style', values: [source.variants[0]] }],
        variants: [{
          title: source.variants[0],
          sku: SKU,
          options: { Style: source.variants[0] },
          prices: [{ currency_code: 'usd', amount: source.price }],
          manage_inventory: false,
          allow_backorder: false,
        }],
        material: 'High-Density Corrugated Cardboard',
        metadata: {
          source_catalog_id: source.id,
          reviewed_for_sale: false,
          import_contract: 'pawshop-local-v1',
        },
      }],
    },
  })
  if (result.length !== 1) throw new Error('Backend did not create exactly one product draft.')
  console.log('Imported one unpublished PawShop catalog draft.');
}
