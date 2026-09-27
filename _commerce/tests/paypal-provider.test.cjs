'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// The PayPal provider lives under `src/modules/paypal` as TypeScript. The
// compiled output is not importable from a plain CJS test, so this test asserts
// the *source* invariants that keep the provider honest — the same technique
// the repository uses for its other "never-run" scripts. The runtime behaviour
// is covered end-to-end in the Sandbox acceptance run.
const fs = require('node:fs');
const path = require('node:path');

const servicePath = path.join(__dirname, '..', 'src', 'modules', 'paypal', 'service.ts');
const indexPath = path.join(__dirname, '..', 'src', 'modules', 'paypal', 'index.ts');
const source = fs.readFileSync(servicePath, 'utf8');
const moduleIndex = fs.readFileSync(indexPath, 'utf8');

test('the PayPal provider extends AbstractPaymentProvider with identifier "paypal"', () => {
  assert.match(source, /extends AbstractPaymentProvider<Options>/);
  assert.match(source, /static identifier = 'paypal'/);
  // provider id resolves to pp_paypal_paypal when registered with id: "paypal".
  assert.match(source, /static identifier = 'paypal'/);
});

test('the provider implements every required lifecycle method', () => {
  const requiredMethods = [
    'initiatePayment', 'authorizePayment', 'capturePayment', 'refundPayment',
    'cancelPayment', 'deletePayment', 'updatePayment', 'retrievePayment',
    'getPaymentStatus', 'getWebhookActionAndData',
  ];
  for (const method of requiredMethods) {
    assert.match(source, new RegExp(`async ${method}\\(`), `${method} is implemented`);
  }
});

test('initiatePayment uses intent AUTHORIZE (authorize/capture split), never CAPTURE', () => {
  assert.match(source, /intent: 'AUTHORIZE'/);
  assert.doesNotMatch(source, /intent: 'CAPTURE'/);
});

test('initiatePayment echoes the Medusa session id into PayPal custom_id', () => {
  // The framework passes the session id in input.data.session_id; the provider
  // must persist it into purchase_units[0].custom_id so the webhook can recover
  // which Medusa session a PayPal event belongs to.
  assert.match(source, /sessionId = \(input\.data\?\.session_id/);
  assert.match(source, /custom_id: sessionId/);
});

test('authorizePayment calls the PayPal authorize endpoint, not just a GET', () => {
  // Approving an AUTHORIZE-intent order leaves it at APPROVED with no
  // authorization. The provider must POST /v2/checkout/orders/{id}/authorize
  // to actually create the authorization; a bare GET would leave PayPal holding
  // no authorization and the later capture would have nothing to capture.
  assert.match(source, /\/v2\/checkout\/orders\/\$\{externalId\}\/authorize/);
  assert.match(source, /'POST'/);
  // Reads back the authorization id from the authorize/capture response.
  assert.match(source, /authorization_id: authorizationId/);
});

test('webhook maps APPROVED -> authorized and COMPLETED -> captured, and rejects unknown events', () => {
  assert.match(source, /CHECKOUT\.ORDER\.APPROVED/);
  assert.match(source, /action: 'authorized'/);
  assert.match(source, /PAYMENT\.CAPTURE\.COMPLETED/);
  assert.match(source, /action: 'captured'/);
  // Refunds are Medusa-driven and must never re-trigger completion.
  assert.match(source, /REFUNDED/);
  assert.match(source, /not_supported/);
  // Unknown events resolve to not_supported, never a fabricated success.
  assert.match(source, /default:\s*return noSession/);
});

test('validateOptions requires the full credential set and a boolean sandbox flag', () => {
  assert.match(source, /static validateOptions/);
  for (const field of ['client_id', 'client_secret', 'webhook_id', 'return_url', 'cancel_url']) {
    assert.match(source, new RegExp(`'${field}'`), `validates ${field}`);
  }
  assert.match(source, /sandbox` must be a boolean/);
});

test('the module registers as a PAYMENT provider with the paypal service', () => {
  assert.match(moduleIndex, /ModuleProvider\(Modules\.PAYMENT/);
  assert.match(moduleIndex, /services: \[PayPalPaymentProviderService\]/);
});

test('the webhook verifies the PayPal transmission signature before acting', () => {
  // A forged CHECKOUT.ORDER.APPROVED must never drive a cart to completion.
  // The provider must ask PayPal to verify the transmission (server-to-server)
  // and treat a failed/missing signature exactly like an unmatchable session.
  assert.match(source, /verifyWebhookSignature/);
  assert.match(source, /paypal-transmission-id/);
  assert.match(source, /paypal-transmission-sig/);
  assert.match(source, /paypal-cert-url/);
  assert.match(source, /paypal-auth-algo/);
  assert.match(source, /\/v1\/notifications\/verify-webhook-signature/);
  assert.match(source, /verification_status === 'SUCCESS'/);
  // The gate is consulted inside getWebhookActionAndData before any event map.
  assert.match(source, /const verified = await this\.verifyWebhookSignature\(payload\)/);
  assert.match(source, /if \(!verified\)/);
  // A rejection resolves to not_supported, never a fabricated success.
  assert.match(source, /return noSession/);
});
