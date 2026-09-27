import { model } from '@medusajs/framework/utils'

// The durable identity bridge between a CloudGull product and the PawShop
// product it owns.
//
// This table is what makes `source.productId` a *stable* external product id:
// the mapping is written once on create and never recomputed, so a retitle, a
// reprice or a lost response can never produce a second PawShop product for the
// same CloudGull product. It also pins the public `handle`, so the product URL
// does not move when the title changes.
export const ConnectorProductMapping = model.define('ConnectorProductMapping', {
  id: model.id({ prefix: 'cgmap' }).primaryKey(),
  // CloudGull's stable product id, taken from the request path.
  source_product_id: model.text(),
  // The PawShop product id returned to CloudGull as `productId`.
  product_id: model.text(),
  // Frozen on first create; recycled verbatim on every later revision.
  handle: model.text().nullable(),
  // Last revision successfully applied, and the `ps-r<n>` version we returned.
  last_revision: model.number().nullable(),
  external_version: model.text().nullable(),
}).indexes([
  {
    name: 'IDX_connector_product_mapping_source_product_id_unique',
    on: ['source_product_id'],
    unique: true,
  },
  {
    name: 'IDX_connector_product_mapping_product_id',
    on: ['product_id'],
  },
])
