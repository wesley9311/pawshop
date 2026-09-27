import { model } from '@medusajs/framework/utils'

// Append-only record of every connector request outcome, successful or not.
//
// This is PawShop's own trace of what an external service asked it to do — the
// counterpart to CloudGull's `connector_sync_audits`, which only sees what the
// client observed. A request that failed authentication is recorded here even
// though CloudGull never learned PawShop's view of it.
//
// Deliberately absent: the Authorization header, the service token, the signing
// secret and the request signature. `request_body_sha256` is enough to tie a row
// to a specific body without storing the body, and `key_id` is a non-sensitive
// identifier by contract.
export const ConnectorAuditEvent = model.define('ConnectorAuditEvent', {
  id: model.id({ prefix: 'cgaudt' }).primaryKey(),
  occurred_at: model.dateTime(),
  method: model.text(),
  path: model.text(),
  // Null when the request never got far enough to identify a credential.
  key_id: model.text().nullable(),
  key_version: model.text().nullable(),
  source_product_id: model.text().nullable(),
  product_id: model.text().nullable(),
  idempotency_key: model.text().nullable(),
  request_body_sha256: model.text().nullable(),
  // read | created | updated | replayed | rejected | error
  outcome: model.text(),
  http_status: model.number(),
  error_code: model.text().nullable(),
  duration_ms: model.number().nullable(),
  detail: model.json().nullable(),
}).indexes([
  {
    name: 'IDX_connector_audit_event_occurred_at',
    on: ['occurred_at'],
  },
  {
    name: 'IDX_connector_audit_event_source_product_id',
    on: ['source_product_id'],
  },
  {
    name: 'IDX_connector_audit_event_idempotency_key',
    on: ['idempotency_key'],
  },
])
