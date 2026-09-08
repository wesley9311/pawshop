'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MIN_MEMORY_KIB, MIN_AVAILABLE_DISK_KIB, parseMemTotal, assertProductionHost } = require('../scripts/production-host-policy.cjs');

test('production host parser reads Linux MemTotal', () => {
  assert.equal(parseMemTotal('MemTotal:       2048000 kB\nMemFree: 1 kB\n'), 2048000);
  assert.throws(() => parseMemTotal('MemFree: 1 kB\n'), /total host memory/);
});

test('production host rejects undersized RAM and disk', () => {
  assert.doesNotThrow(() => assertProductionHost({ memoryKib: MIN_MEMORY_KIB, availableDiskKib: MIN_AVAILABLE_DISK_KIB }));
  assert.throws(() => assertProductionHost({ memoryKib: MIN_MEMORY_KIB - 1, availableDiskKib: MIN_AVAILABLE_DISK_KIB }), /2 GB RAM/);
  assert.throws(() => assertProductionHost({ memoryKib: MIN_MEMORY_KIB, availableDiskKib: MIN_AVAILABLE_DISK_KIB - 1 }), /8 GB available/);
});
