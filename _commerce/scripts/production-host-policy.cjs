'use strict';

// Alibaba Cloud's reviewed 2 GiB SWAS plan exposes 1,651,800 KiB to Ubuntu.
// Keep enough tolerance for provider-reserved memory while rejecting the former
// 1 GiB plan (measured at roughly 915,000 KiB).
const MIN_MEMORY_KIB = 1_600_000;
const MIN_AVAILABLE_DISK_KIB = 8 * 1024 * 1024;
const PRODUCTION_NODE_PATH = '/usr/bin/node';

function parseMemTotal(source) {
  const match = /^MemTotal:\s+(\d+)\s+kB$/m.exec(source);
  if (!match) throw new Error('Unable to read total host memory.');
  return Number(match[1]);
}

function assertProductionHost({ memoryKib, availableDiskKib }) {
  if (!Number.isSafeInteger(memoryKib) || memoryKib < MIN_MEMORY_KIB) {
    throw new Error('Production commerce requires the reviewed 2 GB plan and at least 1,600,000 KiB reported RAM.');
  }
  if (!Number.isSafeInteger(availableDiskKib) || availableDiskKib < MIN_AVAILABLE_DISK_KIB) {
    throw new Error('Production commerce requires at least 8 GB available disk before deployment.');
  }
}

function assertProductionNodeRuntime({ version, executablePath }) {
  if (!/^v(?:22|24)\.\d+\.\d+$/.test(version)) {
    throw new Error('Production commerce requires Node 22 or 24 LTS.');
  }
  if (executablePath !== PRODUCTION_NODE_PATH) {
    throw new Error(`Production commerce must run with ${PRODUCTION_NODE_PATH}.`);
  }
}

module.exports = {
  MIN_MEMORY_KIB,
  MIN_AVAILABLE_DISK_KIB,
  PRODUCTION_NODE_PATH,
  parseMemTotal,
  assertProductionHost,
  assertProductionNodeRuntime,
};
