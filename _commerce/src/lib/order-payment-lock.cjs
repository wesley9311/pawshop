'use strict';
const { randomUUID } = require('node:crypto');

// Serialize our Admin fulfillment/refund mutations and external reconciliation
// for an order. The response owns the lock until the route has completed.
async function acquireOrderPaymentLock(scope, orderId) {
  const locking = scope.resolve('locking');
  const ownerId = randomUUID();
  const key = `pawshop-order-payment:${orderId}`;
  await locking.acquire(key, { ownerId, expire: 120 });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await locking.release(key, { ownerId });
  };
}

function releaseAfterResponse(res, release) {
  if (typeof res.once !== 'function') throw new Error('Payment lock requires a response lifecycle.');
  const done = () => { release().catch(() => {}); };
  res.once('finish', done);
  res.once('close', done);
}

async function serializeAdminRefund(req, res, next) {
  let release;
  try {
    const { data } = await req.scope.resolve('query').graph({
      entity: 'payment', fields: ['id', 'payment_collection.order.id'],
      filters: { id: req.params.id },
    });
    const orderId = data[0]?.payment_collection?.order?.id;
    if (!orderId) return res.status(409).json({ code: 'payment_order_unresolved' });
    release = await acquireOrderPaymentLock(req.scope, orderId);
    releaseAfterResponse(res, release);
    return next();
  } catch (_) {
    if (release) await release().catch(() => {});
    return res.status(503).json({ code: 'payment_lock_unavailable' });
  }
}
module.exports = { acquireOrderPaymentLock, releaseAfterResponse, serializeAdminRefund };
