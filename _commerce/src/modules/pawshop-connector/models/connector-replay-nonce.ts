import { model } from '@medusajs/framework/utils'

// Replay protection, made durable.
//
// CloudGull generates a fresh nonce per attempt and the server must refuse a
// (keyId, nonce) pair seen inside the clock-skew window. Holding that set in
// process memory would lose the window on every restart and would not be shared
// between instances, so the claim is a row: the unique index on
// (key_id, nonce) is the entire mechanism, and a duplicate insert IS the
// detection. Rows are pruned once their window has passed.
export const ConnectorReplayNonce = model.define('ConnectorReplayNonce', {
  id: model.id({ prefix: 'cgnonc' }).primaryKey(),
  key_id: model.text(),
  nonce: model.text(),
  claimed_at: model.dateTime(),
  expires_at: model.dateTime(),
}).indexes([
  {
    name: 'IDX_connector_replay_nonce_key_unique',
    on: ['key_id', 'nonce'],
    unique: true,
  },
  {
    name: 'IDX_connector_replay_nonce_expires_at',
    on: ['expires_at'],
  },
])
