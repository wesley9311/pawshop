'use strict';

const MIN_MEMORY_KIB = 1_800_000;
const MIN_AVAILABLE_DISK_KIB = 8 * 1024 * 1024;
const PRODUCTION_NODE_PATH = '/usr/bin/node';

function parseMemTotal(source) {
  const match = /^MemTotal:\s+(\d+)\s+kB$/m.exec(source);
  if (!match) throw new Error('Unable to read total host memory.');
  return Number(match[1]);
}

function assertProductionHost({ memoryKib, availableDiskKib }) {
  if (!Number.isSafeInteger(memoryKib) || memoryKib < MIN_MEMORY_KIB) {
    throw new Error('Production commerce requires at least a nominal 2 GB RAM host.');
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
