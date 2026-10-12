'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('ts-node/register/transpile-only');

const Provider = require('../src/modules/paypal/service.ts').default;
const { reconcilePayPalExternalPayment } = require('../src/lib/paypal-reconciliation.ts');
const { paymentGateDecision } = require('../src/lib/fulfillment-payment-gate.cjs');

const logger = { info() {}, warn() {}, error() {} };
const options = {
  client_id: 'sandbox-client', client_secret: 'sandbox-secret', sandbox: true,
  webhook_id: 'sandbox-webhook', return_url: 'https://pawlivora.com/PawShop.html',
  cancel_url: 'https://pawlivora.com/PawShop.html',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function order({ status = 'COMPLETED', authorization = 'AUTH-1', capture = null } = {}) {
  return {
    id: 'ORDER-1', status, intent: 'AUTHORIZE',
    purchase_units: [{
      amount: { value: '25.00', currency_code: 'USD' },
      payments: {
        authorizations: authorization ? [{ id: authorization, status: 'CREATED' }] : [],
        captures: capture ? [capture] : [],
      },
    }],
  };
}

function paymentData() {
  return { paypal_environment: 'sandbox', id: 'ORDER-1', expected_amount: '25.00', currency_code: 'USD' };
}

test('backend authorization performs one exact full capture with a stable PayPal request id', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  const replies = [
    jsonResponse({ access_token: 'token', expires_in: 3600 }),
    jsonResponse(order({ status: 'APPROVED', authorization: null })),
    jsonResponse(order()),
    jsonResponse({ id: 'CAP-1', status: 'COMPLETED', amount: { value: '25.00', currency_code: 'USD' } }),
  ];
  global.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return replies.shift(); };
  const provider = new Provider({ logger }, options);
  const result = await provider.authorizePayment({ data: paymentData(), context: {} });
  assert.equal(result.status, 'captured');
  assert.equal(result.data.capture_id, 'CAP-1');
  const capture = calls.find((call) => call.url.endsWith('/v2/payments/authorizations/AUTH-1/capture'));
  assert.ok(capture, 'server performs the capture');
  assert.match(capture.init.headers['PayPal-Request-Id'], /^[a-f0-9]{32}$/);
});

test('a repeated callback adopts the existing capture and never captures twice', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  const existing = { id: 'CAP-1', status: 'COMPLETED', amount: { value: '25.00', currency_code: 'USD' } };
  const replies = [
    jsonResponse({ access_token: 'token', expires_in: 3600 }),
    jsonResponse(order({ capture: existing })),
    jsonResponse(order({ capture: existing })),
  ];
  global.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return replies.shift(); };
  const provider = new Provider({ logger }, options);
  assert.equal((await provider.authorizePayment({ data: paymentData(), context: {} })).status, 'captured');
  assert.equal((await provider.authorizePayment({ data: paymentData(), context: {} })).status, 'captured');
  assert.equal(calls.filter((call) => call.url.endsWith('/capture')).length, 0);
});

test('a timeout after provider capture recovers the same capture on retry', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  const replies = [
    jsonResponse({ access_token: 'token', expires_in: 3600 }),
    jsonResponse(order()),
    new Error('socket timeout after write'),
    jsonResponse(order({ capture: {
      id: 'CAP-RECOVERED', status: 'COMPLETED', amount: { value: '25.00', currency_code: 'USD' },
    } })),
  ];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const provider = new Provider({ logger }, options);
  await assert.rejects(provider.authorizePayment({ data: paymentData(), context: {} }), /socket timeout/);
  const recovered = await provider.authorizePayment({ data: paymentData(), context: {} });
  assert.equal(recovered.data.capture_id, 'CAP-RECOVERED');
  assert.equal(calls.filter((call) => call.url.endsWith('/capture')).length, 1);
});

test('pending capture stays pending and cannot create a Medusa capture fact', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const replies = [
    jsonResponse({ access_token: 'token', expires_in: 3600 }),
    jsonResponse(order()),
    jsonResponse({ id: 'CAP-PENDING', status: 'PENDING', amount: { value: '25.00', currency_code: 'USD' } }),
  ];
  global.fetch = async () => replies.shift();
  const provider = new Provider({ logger }, options);
  const result = await provider.authorizePayment({ data: paymentData(), context: {} });
  assert.equal(result.status, 'pending_authorization');
});

test('partial or wrong-currency capture fails closed', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  for (const amount of [
    { value: '24.99', currency_code: 'USD' },
    { value: '25.00', currency_code: 'EUR' },
  ]) {
    const replies = [
      jsonResponse({ access_token: 'token', expires_in: 3600 }),
      jsonResponse(order({ capture: { id: 'CAP-BAD', status: 'COMPLETED', amount } })),
    ];
    global.fetch = async () => replies.shift();
    const provider = new Provider({ logger }, options);
    await assert.rejects(
      provider.authorizePayment({ data: paymentData(), context: {} }),
      /amount or currency does not match/,
    );
  }
});

test('AUTHORIZE order COMPLETED without a capture is authorized, never captured', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const replies = [
    jsonResponse({ access_token: 'token', expires_in: 3600 }),
    jsonResponse(order()),
  ];
  global.fetch = async () => replies.shift();
  const provider = new Provider({ logger }, options);
  const retrieved = await provider.retrievePayment({ data: paymentData() });
  assert.equal(retrieved.data.status, 'AUTHORIZED');
  assert.deepEqual(await provider.getPaymentStatus({ data: retrieved.data }), { status: 'authorized' });
});

function paidOrder(overrides = {}) {
  return {
    total: 25, currency_code: 'usd',
    payment_collections: [{ amount: 25, currency_code: 'usd', payments: [{ currency_code: 'usd', captured_at: '2026-10-11T00:00:00Z',
      captures: [{ amount: 25 }], refunds: [],
    }] }],
    ...overrides,
  };
}

test('fulfillment gate requires full net capture at currency precision', () => {
  assert.equal(paymentGateDecision(paidOrder()).allowed, true);
  assert.equal(paymentGateDecision(paidOrder({ payment_collections: [] })).allowed, false);
  assert.equal(paymentGateDecision(paidOrder({
    payment_collections: [{ amount: 25, currency_code: 'usd', payments: [{ currency_code: 'usd', captured_at: '2026-10-11T00:00:00Z', captures: [{ amount: 24.99 }], refunds: [] }] }],
  })).allowed, false);
  assert.equal(paymentGateDecision(paidOrder({
    payment_collections: [{ amount: 25, currency_code: 'usd', payments: [{ currency_code: 'usd', captured_at: '2026-10-11T00:00:00Z', captures: [{ amount: 25 }], refunds: [{ amount: 1 }] }] }],
  })).allowed, false, 'refund blocks later fulfillment');
});

test('zero-total policy allows only a clean zero with no positive payment facts', () => {
  assert.equal(paymentGateDecision({ total: 0, currency_code: 'usd', payment_collections: [] }).allowed, true);
  assert.equal(paymentGateDecision({
    total: 0, currency_code: 'usd', payment_collections: [{ amount: 1, payments: [] }],
  }).allowed, false);
});

test('all five current Admin fulfillment mutation routes have the hard gate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'middlewares.ts'), 'utf8');
  for (const route of [
    '/admin/fulfillments',
    '/admin/orders/:id/fulfillments',
    '/admin/fulfillments/:id/shipment',
    '/admin/orders/:id/fulfillments/:fulfillment_id/shipments',
    '/admin/orders/:id/fulfillments/:fulfillment_id/mark-as-delivered',
  ]) {
    assert.match(source, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('external refund/reversal uses a unique ledger and never calls PayPal refund', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'paypal-reconciliation.ts'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'pawshop-payment-reconciliation', 'migrations', 'Migration20261011000000.ts'), 'utf8');
  assert.match(migration, /provider_event_unique/);
  assert.match(source, /paypal_external_event_id/);
  assert.match(source, /paypal_capture_reversed/);
  assert.doesNotMatch(source, /\/refund['"`]/, 'adoption path must not POST a second provider refund');
  assert.match(source, /refundPaymentWorkflow/);
  assert.match(source, /externalRefundContext\.run/);
  assert.doesNotMatch(source, /maybeUpdatePaymentCollection_/);
});

test('verified Medusa refund webhook recognizes exact mapping and duplicate delivery is a no-op', async (t) => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  t.after(() => { global.fetch = originalFetch; process.env = originalEnv; });
  Object.assign(process.env, {
    PAYPAL_CLIENT_ID: 'sandbox-client', PAYPAL_CLIENT_SECRET: 'sandbox-secret',
    PAYPAL_SANDBOX: 'true', PAYPAL_WEBHOOK_ID: 'sandbox-webhook',
  });
  const event = {
    id: 'WH-EVENT-1', event_type: 'PAYMENT.CAPTURE.REFUNDED',
    resource: { id: 'REFUND-1', supplementary_data: { related_ids: { capture_id: 'CAP-1' } } },
  };
  const record = { id: 'payrec_1', status: 'received' };
  const ledgerRows = [];
  const createdRefunds = [];
  const orderTransactions = [{ id: 'trx_1', reference_id: 'refund_local_1' }];
  const ledger = {
    async listPaymentReconciliations() { return ledgerRows; },
    async createPaymentReconciliations() { ledgerRows.push(record); return record; },
    async updatePaymentReconciliations(update) { Object.assign(record, update); },
  };
  const locking = { async acquire() {}, async release() {} };
  const paymentModule = {
    async createRefunds(input) { createdRefunds.push(input); return { id: 'refund_local_1', ...input }; },
    async maybeUpdatePaymentCollection_() {},
  };
  const orderModule = {
    async listOrderTransactions() { return orderTransactions; },
    async addOrderTransactions(input) { orderTransactions.push(input); },
  };
  const payment = {
    id: 'pay_1', provider_id: 'pp_paypal_paypal', currency_code: 'usd',
    amount: 25, payment_session_id: 'payses_1',
    payment_session: {data:{paypal_environment:'sandbox'}},
    data: { paypal_environment:'sandbox', id: 'ORDER-1', capture_id: 'CAP-1', refund_map: { 'REFUND-1': 'refund_local_1' } },
    captures: [{ amount: 25 }], refunds: [{ id: 'refund_local_1', amount: 5 }],
    payment_collection: { id: 'paycol_1', order: { id: 'order_1' } },
  };
  const query = { async graph() { return { data: [payment] }; } };
  const scope = {
    resolve(key) {
      if (key === 'pawshopPaymentReconciliation') return ledger;
      if (key === 'locking') return locking;
      if (key === 'payment') return paymentModule;
      if (key === 'order') return orderModule;
      if (key === 'query') return query;
      if (key === 'logger') return logger;
      throw new Error(`unexpected dependency ${String(key)}`);
    },
  };
  const responseCodes = [];
  const res = { sendStatus(code) { responseCodes.push(code); return this; }, status(code) { responseCodes.push(code); return this; }, json() { return this; } };
  const req = {
    body: event, rawBody: Buffer.from(JSON.stringify(event)), scope,
    headers: {
      'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api-m.sandbox.paypal.com/cert',
      'paypal-transmission-id': 'tx', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': 'now',
    },
  };
  const paypalReplies = [
    { access_token: 'token', expires_in: 3600 }, { verification_status: 'SUCCESS' },
    { id: 'REFUND-1', status: 'COMPLETED', amount: { value: '5.00', currency_code: 'USD' }, links: [{rel:'up',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/CAP-1'}] },
    { id: 'CAP-1', custom_id: 'payses_1', amount: { value: '25.00', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: 'ORDER-1' } } },
    { access_token: 'token', expires_in: 3600 }, { verification_status: 'SUCCESS' },
  ];
  global.fetch = async () => jsonResponse(paypalReplies.shift());
  await reconcilePayPalExternalPayment(req, res, () => { throw new Error('must intercept refund'); });
  await reconcilePayPalExternalPayment(req, res, () => { throw new Error('must intercept refund'); });
  assert.equal(createdRefunds.length, 0);
  assert.equal(orderTransactions.length, 1);
  assert.equal(record.status, 'applied');
  assert.deepEqual(responseCodes, [200, 200]);
});

test('provisional capture rows, cancelled payments and mixed currencies cannot fulfill', () => {
  for (const override of [
    { captured_at: null }, { canceled_at: '2026-10-11T00:00:00Z' }, { currency_code: 'eur' },
  ]) {
    const fixture = paidOrder();
    Object.assign(fixture.payment_collections[0].payments[0], override);
    assert.equal(paymentGateDecision(fixture).allowed, false);
  }
  const fixture = paidOrder();
  fixture.payment_collections[0].currency_code = 'eur';
  assert.equal(paymentGateDecision(fixture).allowed, false);
});

test('same-amount separate refunds use separate keys while retry keeps its key', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const keys = [];
  global.fetch = async (url, init) => {
    if (String(url).endsWith('/token')) return jsonResponse({ access_token: 'token', expires_in: 3600 });
    keys.push(init.headers['PayPal-Request-Id']);
    return jsonResponse({ id: 'REF-1', status: 'COMPLETED', amount: { value: '5.00', currency_code: 'USD' } });
  };
  const provider = new Provider({ logger }, options);
  for (const id of ['refund_one', 'refund_two', 'refund_one']) {
    await provider.refundPayment({ data: { ...paymentData(), capture_id: 'CAP-1' }, amount: 5, context: { idempotency_key: id } });
  }
  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[0], keys[2]);
});

test('denied capture never returns captured', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const replies = [
    jsonResponse({ access_token: 'token', expires_in: 3600 }), jsonResponse(order()),
    jsonResponse({ id: 'CAP-DENIED', status: 'DECLINED', amount: { value: '25.00', currency_code: 'USD' } }),
  ];
  global.fetch = async () => replies.shift();
  await assert.rejects(new Provider({ logger }, options).authorizePayment({ data: paymentData(), context: {} }), /did not complete/);
});

test('order payment lock has unique owners and releases only when response finishes', async () => {
  const { EventEmitter } = require('node:events');
  const { acquireOrderPaymentLock, releaseAfterResponse } = require('../src/lib/order-payment-lock.cjs');
  const owners = [], released = [];
  const scope = { resolve() { return {
    async acquire(key, options) { owners.push(options.ownerId); assert.equal(key, 'pawshop-order-payment:order_1'); },
    async release(key, options) { released.push(options.ownerId); },
  }; } };
  const res = new EventEmitter();
  const release = await acquireOrderPaymentLock(scope, 'order_1');
  releaseAfterResponse(res, release);
  assert.equal(released.length, 0);
  res.emit('finish'); res.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released.length, 1);
  const release2 = await acquireOrderPaymentLock(scope, 'order_1');
  assert.notEqual(owners[0], owners[1]);
  await release2();
});

test('trusted external refund adoption reads the completed fact without issuing a refund', async (t) => {
  const { externalRefundContext } = require('../src/lib/paypal-external-refund-context.ts');
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({url:String(url),method:init.method});
    return String(url).endsWith('/token')
      ? jsonResponse({access_token:'token',expires_in:3600})
      : jsonResponse({id:'REF-EXTERNAL',status:'COMPLETED',amount:{value:'5.00',currency_code:'USD'}});
  };
  const provider = new Provider({logger}, options);
  const result = await externalRefundContext.run({environment:'sandbox',refundId:'REF-EXTERNAL',captureId:'CAP-1',amount:'5.00',currency:'USD'},
    () => provider.refundPayment({data:{...paymentData(),capture_id:'CAP-1'},amount:5,context:{idempotency_key:'refund_local'}}));
  assert.equal(result.data.refund_map['REF-EXTERNAL'],'refund_local');
  assert.equal(calls.filter((call)=>call.url.includes('/payments/')&&call.method==='POST').length,0);
  await assert.rejects(externalRefundContext.run({environment:'sandbox',refundId:'REF-EXTERNAL',captureId:'OTHER-CAP',amount:'5.00',currency:'USD'},
    () => provider.refundPayment({data:{...paymentData(),capture_id:'CAP-1'},amount:5,context:{idempotency_key:'refund_local'}})),/context mismatch/);
});


test('delayed completed webhook after partial refund is acknowledged without recapture', async (t) => {
 const originalFetch = global.fetch; t.after(() => { global.fetch = originalFetch; });
 const fresh = order({capture:{id:'CAP-1',status:'PARTIALLY_REFUNDED',amount:{value:'25.00',currency_code:'USD'}}});
 fresh.purchase_units[0].custom_id='payses_1';
 const event={event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{id:'CAP-1',custom_id:'payses_1',supplementary_data:{related_ids:{order_id:'ORDER-1'}}}};
 const replies=[{access_token:'token',expires_in:3600},{verification_status:'SUCCESS'},fresh];
 const calls=[];global.fetch=async(url,init={})=>{calls.push([String(url),init.method]);return jsonResponse(replies.shift())};
 const result=await new Provider({logger},options).getWebhookActionAndData({data:event,rawData:Buffer.from(JSON.stringify(event)),headers:{'paypal-auth-algo':'SHA256withRSA','paypal-cert-url':'https://api-m.sandbox.paypal.com/cert','paypal-transmission-id':'tx','paypal-transmission-sig':'sig','paypal-transmission-time':'now'}});
 assert.equal(result.action,'not_supported');
 assert.equal(calls.filter(([url,method])=>method==='POST'&&url.endsWith('/capture')).length,0);
});


test('retry after timeout and stale order read reuses the authorization request key', async(t)=>{
 const originalFetch=global.fetch;t.after(()=>{global.fetch=originalFetch});const keys=[];let attempts=0;
 global.fetch=async(url,init={})=>{
  if(String(url).endsWith('/token'))return jsonResponse({access_token:'token',expires_in:3600});
  if(String(url).endsWith('/capture')){keys.push(init.headers['PayPal-Request-Id']);if(++attempts===1)throw Error('response lost');return jsonResponse({id:'CAP-1',status:'COMPLETED',amount:{value:'25.00',currency_code:'USD'}})}
  return jsonResponse(order());
 };
 const provider=new Provider({logger},options);await assert.rejects(provider.authorizePayment({data:paymentData(),context:{}}));
 const recovered=await provider.authorizePayment({data:paymentData(),context:{}});assert.equal(recovered.data.capture_id,'CAP-1');assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
});

test('reversal event enters durable review, alerts and never records a refund', async (t) => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  t.after(() => { global.fetch = originalFetch; process.env = originalEnv; });
  Object.assign(process.env, {
    PAYPAL_CLIENT_ID: 'sandbox-client', PAYPAL_CLIENT_SECRET: 'sandbox-secret',
    PAYPAL_SANDBOX: 'true', PAYPAL_WEBHOOK_ID: 'sandbox-webhook',
  });
  const event = {
    id: 'WH-EVENT-1', event_type: 'PAYMENT.CAPTURE.REVERSED',
    resource: { id: 'CAP-1', supplementary_data: { related_ids: { capture_id: 'CAP-1' } } },
  };
  const record = { id: 'payrec_1', status: 'received' };
  const ledgerRows = [];
  const createdRefunds = [];
  const orderTransactions = [{ id: 'trx_1', reference_id: 'refund_local_1' }];
  const ledger = {
    async listPaymentReconciliations() { return ledgerRows; },
    async createPaymentReconciliations() { ledgerRows.push(record); return record; },
    async updatePaymentReconciliations(update) { Object.assign(record, update); },
  };
  const locking = { async acquire() {}, async release() {} };
  const paymentModule = {
    async createRefunds(input) { createdRefunds.push(input); return { id: 'refund_local_1', ...input }; },
    async maybeUpdatePaymentCollection_() {},
  };
  const orderModule = {
    async listOrderTransactions() { return orderTransactions; },
    async addOrderTransactions(input) { orderTransactions.push(input); },
  };
  const payment = {
    id: 'pay_1', provider_id: 'pp_paypal_paypal', currency_code: 'usd',
    amount: 25, payment_session_id: 'payses_1',
    payment_session: {data:{paypal_environment:'sandbox'}},
    data: { paypal_environment:'sandbox', id: 'ORDER-1', capture_id: 'CAP-1', refund_map: {} },
    captures: [{ amount: 25 }], refunds: [],
    payment_collection: { id: 'paycol_1', order: { id: 'order_1' } },
  };
  const query = { async graph() { return { data: [payment] }; } };
  const scope = {
    resolve(key) {
      if (key === 'pawshopPaymentReconciliation') return ledger;
      if (key === 'locking') return locking;
      if (key === 'payment') return paymentModule;
      if (key === 'order') return orderModule;
      if (key === 'query') return query;
      if (key === 'logger') return logger;
      throw new Error(`unexpected dependency ${String(key)}`);
    },
  };
  const alerts=[]; scope.resolve = ((original)=>function(key){if(key==='logger')return {error(message){alerts.push(message)}};return original.call(this,key)})(scope.resolve);
  const responseCodes = [];
  const res = { sendStatus(code) { responseCodes.push(code); return this; }, status(code) { responseCodes.push(code); return this; }, json() { return this; } };
  const req = {
    body: event, rawBody: Buffer.from(JSON.stringify(event)), scope,
    headers: {
      'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api-m.sandbox.paypal.com/cert',
      'paypal-transmission-id': 'tx', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': 'now',
    },
  };
  const paypalReplies = [
    { access_token: 'token', expires_in: 3600 }, { verification_status: 'SUCCESS' },
    { id: 'CAP-1', status: 'REVERSED', amount: { value: '25.00', currency_code: 'USD' } },
    { id: 'CAP-1', custom_id: 'payses_1', amount: { value: '25.00', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: 'ORDER-1' } } },
    { access_token: 'token', expires_in: 3600 }, { verification_status: 'SUCCESS' },
  ];
  global.fetch = async () => jsonResponse(paypalReplies.shift());
  await reconcilePayPalExternalPayment(req, res, () => { throw new Error('must intercept refund'); });
  await reconcilePayPalExternalPayment(req, res, () => { throw new Error('must intercept refund'); });
  assert.equal(createdRefunds.length, 0);
  assert.equal(orderTransactions.length, 1);
  assert.equal(record.status, 'review');assert.equal(record.reason,'paypal_capture_reversed');assert.equal(alerts.length,1);assert.match(alerts[0],/requires review/);
  assert.deepEqual(responseCodes, [200, 200]);
});


test('unapproved read-back preserves durable automatic recovery eligibility', async(t)=>{
 const original=global.fetch;t.after(()=>{global.fetch=original});const replies=[jsonResponse({access_token:'token',expires_in:3600}),jsonResponse(order({status:'CREATED',authorization:null}))];global.fetch=async()=>replies.shift();
 const result=await new Provider({logger},options).authorizePayment({data:{...paymentData(),auto_capture_policy:'pawshop-auto-capture-v1'},context:{}});
 assert.equal(result.status,'pending');assert.equal(result.data.auto_capture_policy,'pawshop-auto-capture-v1');assert.equal(result.data.expected_amount,'25.00');
});
