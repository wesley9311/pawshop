'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_MEMORY_KIB,
  MIN_AVAILABLE_DISK_KIB,
  PRODUCTION_NODE_PATH,
  parseMemTotal,
  assertProductionHost,
  assertProductionNodeRuntime,
} = require('../scripts/production-host-policy.cjs');

test('production host parser reads Linux MemTotal', () => {
  assert.equal(parseMemTotal('MemTotal:       2048000 kB\nMemFree: 1 kB\n'), 2048000);
  assert.throws(() => parseMemTotal('MemFree: 1 kB\n'), /total host memory/);
});

test('production host rejects undersized RAM and disk', () => {
  assert.doesNotThrow(() => assertProductionHost({ memoryKib: MIN_MEMORY_KIB, availableDiskKib: MIN_AVAILABLE_DISK_KIB }));
  assert.doesNotThrow(() => assertProductionHost({ memoryKib: 1651800, availableDiskKib: MIN_AVAILABLE_DISK_KIB }));
  assert.throws(() => assertProductionHost({ memoryKib: MIN_MEMORY_KIB - 1, availableDiskKib: MIN_AVAILABLE_DISK_KIB }), /1,600,000 KiB reported RAM/);
  assert.throws(() => assertProductionHost({ memoryKib: MIN_MEMORY_KIB, availableDiskKib: MIN_AVAILABLE_DISK_KIB - 1 }), /8 GB available/);
});

test('production host accepts only the system Node 22 or 24 LTS runtime', () => {
  for (const version of ['v22.12.0', 'v24.0.0']) {
    assert.doesNotThrow(() => assertProductionNodeRuntime({ version, executablePath: PRODUCTION_NODE_PATH }));
  }
  for (const version of ['v20.19.0', 'v23.11.0', '22.12.0']) {
    assert.throws(() => assertProductionNodeRuntime({ version, executablePath: PRODUCTION_NODE_PATH }), /Node 22 or 24 LTS/);
  }
  assert.throws(
    () => assertProductionNodeRuntime({ version: 'v22.12.0', executablePath: '/opt/node/bin/node' }),
    /\/usr\/bin\/node/,
  );
});
