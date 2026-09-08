'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listenerHosts, assertLoopbackListeners } = require('../scripts/private-listener-policy.cjs');

const privateListeners = [
  'LISTEN 0 244 127.0.0.1:5432 0.0.0.0:*',
  'LISTEN 0 511 127.0.0.1:6379 0.0.0.0:*',
  'LISTEN 0 511 127.0.0.1:9000 0.0.0.0:*',
].join('\n');

test('production data and API listeners are all required on IPv4 loopback', () => {
  assert.deepEqual(listenerHosts(privateListeners, 5432), ['127.0.0.1']);
  assert.doesNotThrow(() => assertLoopbackListeners(privateListeners));
  assert.throws(() => assertLoopbackListeners(privateListeners.replace('127.0.0.1:6379', '0.0.0.0:6379')), /6379/);
  assert.throws(() => assertLoopbackListeners(privateListeners.replace(/^.*:9000.*$/m, '')), /9000/);
  assert.throws(() => assertLoopbackListeners(`${privateListeners}\nLISTEN 0 511 [::]:5432 [::]:*`), /5432/);
});
