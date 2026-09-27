import { model } from '@medusajs/framework/utils'

// One row per Idempotency-Key that produced a committed write.
//
// The contract requires that replaying the same Idempotency-Key returns the same
// `productId` with `replayed: true` — including when the first response was lost
// in transit and the client is retrying. That is why the *response* is stored
// and re-emitted rather than recomputed: a recomputation could legitimately
// report `created: false` and break the caller's bookkeeping.
//
// `request_body_sha256` is not part of the contract; it lets the connector
// detect a key reused for a different body instead of silently discarding the
// new content (see IDEMPOTENCY_KEY_CONFLICT).
//
// No secret ever lands here: the service token and signing secret are never
// part of a request body or header that this table records.
export const ConnectorIdempotencyRecord = model.define('ConnectorIdempotencyRecord', {
  id: model.id({ prefix: 'cgidem' }).primaryKey(),
  idempotency_key: model.text(),
  key_id: model.text(),
  source_product_id: model.text(),
  product_id: model.text(),
  response_status: model.number(),
  response_body: model.json(),
  request_body_sha256: model.text(),
  // Retention boundary. Product-id stability is permanent via
  // ConnectorProductMapping; only the *replay* guarantee is windowed.
  expires_at: model.dateTime(),
}).indexes([
  {
    name: 'IDX_connector_idempotency_record_key_unique',
    on: ['idempotency_key'],
    unique: true,
  },
  {
    name: 'IDX_connector_idempotency_record_expires_at',
    on: ['expires_at'],
  },
])
