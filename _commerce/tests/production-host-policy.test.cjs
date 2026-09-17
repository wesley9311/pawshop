'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  MIN_MEMORY_KIB,
  MIN_AVAILABLE_DISK_KIB,
  parseMemTotal,
  assertProductionHost,
  assertProductionNodeRuntime,
} = require('../scripts/production-host-policy.cjs');

// Reproduce the reviewed production layout inside a temporary directory:
// `bootstrap-ubuntu-host.sh` installs the pinned runtime under /opt and links it
// into /usr/bin, so the reviewed path is a symbolic link while the running
// process reports the resolved target. Passing the absolute target as the
// executable and the link as the reviewed path is exactly that arrangement.
function reviewedRuntimeLayout() {
  const directory = mkdtempSync(join(tmpdir(), 'pawshop-node-policy-'));
  const pinnedRoot = join(directory, 'node-v22.23.2-linux-x64');
  mkdirSync(pinnedRoot);
  const target = join(pinnedRoot, 'node');
  const other = join(directory, 'stray-node');
  writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(other, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const link = join(directory, 'node');
  symlinkSync(target, link);
  return { directory, target, other, link };
}

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

test('production host accepts the resolved runtime behind the reviewed symlink', () => {
  const layout = reviewedRuntimeLayout();
  assert.doesNotThrow(() => assertProductionNodeRuntime({
    version: 'v22.23.2', executablePath: layout.target, expectedNodePath: layout.link,
  }));
});

test('production host rejects a runtime outside the reviewed path', () => {
  const layout = reviewedRuntimeLayout();
  assert.throws(() => assertProductionNodeRuntime({
    version: 'v22.23.2', executablePath: layout.other, expectedNodePath: layout.link,
  }), /must run with/);
  assert.throws(() => assertProductionNodeRuntime({
    version: 'v22.23.2', executablePath: layout.target,
    expectedNodePath: join(layout.directory, 'absent-node'),
  }), /must run with/);
});

test('the reviewed production runtime path is unreachable from a stray executable', () => {
  assert.throws(() => assertProductionNodeRuntime({
    version: 'v22.23.2', executablePath: '/opt/node/bin/node',
  }), /\/usr\/bin\/node/);
});

test('production host accepts only the system Node 22 or 24 LTS runtime', () => {
  const layout = reviewedRuntimeLayout();
  for (const version of ['v22.12.0', 'v24.0.0']) {
    assert.doesNotThrow(() => assertProductionNodeRuntime({
      version, executablePath: layout.target, expectedNodePath: layout.link,
    }));
  }
  for (const version of ['v20.19.0', 'v23.11.0', '22.12.0']) {
    assert.throws(() => assertProductionNodeRuntime({
      version, executablePath: layout.target, expectedNodePath: layout.link,
    }), /Node 22 or 24 LTS/);
  }
});
