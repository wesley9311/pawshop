import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildProductionEnvironment } = require('./production-environment-builder.cjs');

if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.argv.length !== 6) {
  throw new Error('Production environment writer requires root on Linux and three private inputs plus one output.');
}

function readRegularNoFollow(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error('Production credential input must be a regular file.');
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

const [, , internalPath, accessKeyPath, secretKeyPath, outputPath] = process.argv;
const source = buildProductionEnvironment({
  internalSource: readRegularNoFollow(internalPath),
  accessKeySource: readRegularNoFollow(accessKeyPath),
  secretKeySource: readRegularNoFollow(secretKeyPath),
});
const output = openSync(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
try {
  writeFileSync(output, source, { encoding: 'utf8' });
  fsyncSync(output);
} finally {
  closeSync(output);
}
console.log('Validated production environment staging file created.');
