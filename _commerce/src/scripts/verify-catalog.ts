import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, ProductStatus } from '@medusajs/framework/utils'

const HANDLE = 'large-corrugated-cardboard-cat-lounger'

export default async function verifyCatalog({ container }: ExecArgs) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: products } = await query.graph({
    entity: 'product',
    fields: [
      'id', 'handle', 'status', 'metadata', 'images.url',
      'variants.sku', 'variants.prices.amount', 'variants.prices.currency_code',
    ],
    filters: { handle: HANDLE },
  })
  if (products.length !== 1) throw new Error(`Expected one draft, found ${products.length}.`)
  const product = products[0] as any
  if (product.status !== ProductStatus.DRAFT) throw new Error('Product must remain unpublished.')
  if (product.images?.length !== 9) throw new Error('Product must have nine approved images.')
  if (product.variants?.length !== 1 || product.variants[0].sku !== 'PAW-CSL-NG-001') throw new Error('SKU contract is incorrect.')
  const usd = product.variants[0].prices?.find((price: any) => price.currency_code === 'usd')
  if (!usd || usd.amount !== 29.9) throw new Error(`Expected USD 29.90, found ${usd?.amount}.`)
  if (product.metadata?.reviewed_for_sale !== false) throw new Error('Product must remain marked unreviewed for sale.')
  console.log('Catalog verification passed: one unpublished SKU, nine images, USD 29.90.');
}
