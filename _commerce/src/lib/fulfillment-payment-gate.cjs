'use strict';

const { ContainerRegistrationKeys } = require('@medusajs/framework/utils');
const { acquireOrderPaymentLock, releaseAfterResponse } = require('./order-payment-lock.cjs');
const { refetchEntities } = require('@medusajs/framework/http');

function amount(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (value && typeof value === 'object' && 'value' in value) return Number(value.value);
  return Number(value);
}

function currencyDigits(code) {
  // PawShop currently settles USD. Keep the common zero/three-decimal cases
  // explicit so an unexpected currency fails closed instead of using a float
  // epsilon that can accept an underpayment.
  const normalized = String(code || '').toUpperCase();
  if (['JPY', 'KRW'].includes(normalized)) return 0;
  if (['BHD', 'JOD', 'KWD', 'OMR', 'TND'].includes(normalized)) return 3;
  if (/^[A-Z]{3}$/.test(normalized)) return 2;
  return null;
}

function minor(value, digits) {
  const numeric = amount(value);
  if (!Number.isFinite(numeric)) return null;
  const scale = 10 ** digits;
  const scaled = numeric * scale;
  const rounded = Math.round(scaled);
  return Math.abs(scaled - rounded) <= 0.000001 ? rounded : null;
}

function sum(rows, field) {
  return (Array.isArray(rows) ? rows : []).reduce((total, row) => {
    const value = amount(row && (row[`raw_${field}`] ?? row[field]));
    return total + (Number.isFinite(value) && value >= 0 ? value : NaN);
  }, 0);
}

function paymentGateDecision(order) {
  const total = amount(order && (order.raw_total ?? order.total));
  const digits = currencyDigits(order && order.currency_code);
  const totalMinor = digits === null ? null : minor(total, digits);
  if (totalMinor === null || totalMinor < 0) {
    return { allowed: false, reason: 'invalid_order_total' };
  }

  const collections = Array.isArray(order && order.payment_collections)
    ? order.payment_collections
    : [];
  const currency = String(order.currency_code).toLowerCase();
  if (collections.some((collection) => String(collection.currency_code || '').toLowerCase() !== currency)) {
    return { allowed: false, reason: 'payment_currency_mismatch' };
  }
  const payments = collections.flatMap((collection) => collection.payments || []);
  if (payments.some((payment) =>
    String(payment.currency_code || '').toLowerCase() !== currency ||
    payment.canceled_at ||
    ((payment.captures || []).length > 0 && !payment.captured_at)
  )) {
    return { allowed: false, reason: 'payment_capture_unconfirmed' };
  }
  const captured = payments.reduce((value, payment) => value + sum(payment.captures, 'amount'), 0);
  const refunded = payments.reduce((value, payment) => value + sum(payment.refunds, 'amount'), 0);
  const collectionAmount = collections.reduce((value, collection) => {
    const next = amount(collection && (collection.raw_amount ?? collection.amount));
    return value + (Number.isFinite(next) && next >= 0 ? next : NaN);
  }, 0);
  const capturedMinor = minor(captured, digits);
  const refundedMinor = minor(refunded, digits);
  const collectionMinor = minor(collectionAmount, digits);
  if (totalMinor === 0) {
    const cleanZero = capturedMinor === 0 && refundedMinor === 0 && collectionMinor === 0;
    return { allowed: cleanZero, reason: cleanZero ? 'zero_total_order' : 'zero_total_has_payment', total, captured, refunded };
  }
  if (capturedMinor === null || refundedMinor === null || collectionMinor === null) {
    return { allowed: false, reason: 'invalid_payment_amount' };
  }
  const netCaptured = captured - refunded;
  const netCapturedMinor = capturedMinor - refundedMinor;
  // Credit-line and split-collection orders are not an active PawShop checkout
  // mode. If they appear, require an explicit policy instead of assuming paid.
  const complete = refundedMinor === 0 && collectionMinor === totalMinor && netCapturedMinor === totalMinor;

  return {
    allowed: complete,
    reason: complete ? 'fully_captured' : 'payment_not_fully_captured',
    total,
    captured,
    refunded,
    netCaptured,
  };
}

async function orderIdForRequest(req) {
  const path = String(req.originalUrl || req.path || '');
  const orderScoped = path.includes('/admin/orders/');
  if (orderScoped && req.params && typeof req.params.id === 'string' &&
      typeof req.params.fulfillment_id !== 'string') {
    return req.params.id;
  }
  if (/\/admin\/fulfillments\/?(?:\?.*)?$/.test(path) && req.body && typeof req.body.order_id === 'string') {
    return req.body.order_id;
  }

  const fulfillmentId = req.params && (
    typeof req.params.fulfillment_id === 'string'
      ? req.params.fulfillment_id
      : typeof req.params.id === 'string'
        ? req.params.id
        : ''
  );
  if (!fulfillmentId) return null;

  const link = await refetchEntities({
    entity: 'order_fulfillment',
    idOrFilter: { fulfillment_id: fulfillmentId },
    scope: req.scope,
    fields: ['order_id'],
  });
  const linkedOrder = link.data && link.data[0] && link.data[0].order_id || null;
  if (orderScoped && linkedOrder !== req.params.id) return null;
  return linkedOrder;
}

async function fetchOrderPaymentFacts(req, orderId) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const result = await query.graph({
    entity: 'order',
    fields: [
      'id',
      'total',
      'raw_total',
      'currency_code',
      'payment_collections.id',
      'payment_collections.amount',
      'payment_collections.currency_code',
      'payment_collections.raw_amount',
      'payment_collections.payments.id',
      'payment_collections.payments.currency_code',
      'payment_collections.payments.captured_at',
      'payment_collections.payments.canceled_at',
      'payment_collections.payments.captures.id',
      'payment_collections.payments.captures.amount',
      'payment_collections.payments.captures.raw_amount',
      'payment_collections.payments.refunds.id',
      'payment_collections.payments.refunds.amount',
      'payment_collections.payments.refunds.raw_amount',
    ],
    filters: { id: orderId },
  });
  return result.data && result.data[0] || null;
}

async function requireCapturedPayment(req, res, next) {
  let release;
  try {
    const orderId = await orderIdForRequest(req);
    if (!orderId) {
      return res.status(409).json({
        type: 'not_allowed',
        code: 'payment_gate_order_unresolved',
        message: 'Fulfillment is blocked because its order could not be resolved.',
      });
    }
    release = await acquireOrderPaymentLock(req.scope, orderId);
    releaseAfterResponse(res, release);
    const reconciliation = req.scope.resolve('pawshopPaymentReconciliation');
    const unresolved = await reconciliation.listPaymentReconciliations({
      $or: [{ order_id: orderId }, { order_id: null }],
      status: ['received', 'review'],
    });
    if (unresolved.length) {
      return res.status(409).json({
        type: 'not_allowed',
        code: 'payment_reconciliation_required',
        message: 'Fulfillment is blocked while payment reconciliation is required.',
      });
    }
    const order = await fetchOrderPaymentFacts(req, orderId);
    const decision = paymentGateDecision(order);
    if (!order || !decision.allowed) {
      return res.status(409).json({
        type: 'not_allowed',
        code: 'payment_not_fully_captured',
        message: 'Fulfillment requires a fully captured payment.',
      });
    }
    return next();
  } catch (_error) {
    if (release) await release().catch(() => {});
    // Infrastructure/query ambiguity is a payment ambiguity. Fulfillment must
    // fail closed rather than treating a lookup failure as paid.
    return res.status(503).json({
      type: 'service_unavailable',
      code: 'payment_gate_unavailable',
      message: 'Payment status could not be verified.',
    });
  }
}

module.exports = {
  paymentGateDecision,
  orderIdForRequest,
  requireCapturedPayment,
};
