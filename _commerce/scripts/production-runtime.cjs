'use strict';

function productionPort(value = '9000') {
  if (!/^[0-9]+$/.test(value)) throw new Error('PORT must be a decimal integer from 1024 to 65535.');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be a decimal integer from 1024 to 65535.');
  return String(port);
}

module.exports = { productionPort };
