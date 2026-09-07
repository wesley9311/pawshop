import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, ProductStatus } from '@medusajs/framework/utils'
import { createProductsWorkflow } from '@medusajs/core-flows'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const HANDLE = 'large-corrugated-cardboard-cat-lounger'
const SKU = 'PAW-CSL-NG-001'
const PUBLIC_ORIGIN = 'https://pawlivora.com'
const IMAGE_PATH = /^assets\/products\/cat-lounger\/[a-z0-9-]+\.jpg$/

type SourceProduct = {
  id: number
  name: string
  price: number
  images: string[]
  description: string
  active: boolean
  availability: 'prelaunch'
  variants: string[]
}

function validateSource(value: unknown): SourceProduct {
  if (!Array.isArray(value) || value.length !== 1) throw new Error('catalog.json must contain exactly one launch product.')
  const product = value[0] as SourceProduct
  if (product.id !== 1 || product.active !== true) throw new Error('Only reviewed source product id=1 may be imported.')
  if (product.availability !== 'prelaunch' || Object.prototype.hasOwnProperty.call(product, 'stock')) throw new Error('Source product must remain explicitly prelaunch without a public stock claim.')
  if (product.price !== 29.9) throw new Error('Expected the reviewed USD price of 29.90.')
  if (!Array.isArray(product.images) || product.images.length !== 9) throw new Error('Expected exactly nine approved listing images.')
  if (!product.images.every(path => IMAGE_PATH.test(path))) throw new Error('An image path is outside the approved self-hosted product directory.')
  if (!product.name || !product.description || product.variants?.length !== 1) throw new Error('Required product copy or variant is missing.')
  return product
}

export default async function importCatalog({ container }: ExecArgs) {
  const sourcePath = resolve(process.cwd(), '..', 'catalog.json')
  const source = validateSource(JSON.parse(await readFile(sourcePath, 'utf8')))
  const publicImages = source.images.map(path => `${PUBLIC_ORIGIN}/${path}`)
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
      !publicImages.every(url => product.images.some((image: any) => image.url === url)) ||
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
        thumbnail: publicImages[0],
        images: publicImages.map(url => ({ url })),
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
          import_contract: 'pawshop-local-v2',
        },
      }],
    },
  })
  if (result.length !== 1) throw new Error('Backend did not create exactly one product draft.')
  console.log('Imported one unpublished PawShop catalog draft.');
}
