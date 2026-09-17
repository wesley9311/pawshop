import { join, dirname } from 'node:path';
import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateProductionEnvironment } = require('../src/lib/production-policy.cjs');
const { productionPort } = require('./production-runtime.cjs');
validateProductionEnvironment(process.env);
const command = process.argv[2];
if (!['build', 'start', 'db:migrate'].includes(command)) throw new Error('Unsupported production command.');
if (command === 'start' && process.env.PAWSHOP_MIGRATIONS_CONFIRMED !== '1') {
  throw new Error('Production start requires PAWSHOP_MIGRATIONS_CONFIRMED=1 after an explicit backup and migration step.');
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));

// The deployment root stays the source release, because it owns the host preflight
// and the admin verifiers. The Medusa CLI, however, resolves medusa-config relative
// to its own working directory, and the production config exists only as compiled
// JavaScript under .medusa/server. Pointing the CLI at the source directory failed
// with "Cannot find module medusa-config": the TypeScript config needs a dev-mode
// loader that production must not depend on. Server commands therefore run from the
// built directory inside the deployment root, and a missing build fails closed
// instead of silently starting something else.
function requireBuiltServerDirectory(path) {
  const directory = lstatSync(path, { throwIfNoEntry: false });
  if (!directory || !directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('The compiled production server directory is missing or unsafe.');
  }
  for (const entry of ['medusa-config.js', 'package.json']) {
    const file = lstatSync(join(path, entry), { throwIfNoEntry: false });
    if (!file || !file.isFile() || file.isSymbolicLink()) {
      throw new Error(`The compiled production server is missing ${entry}.`);
    }
  }
  return path;
}

const workingDirectory =
  command === 'build' ? root : requireBuiltServerDirectory(join(root, '.medusa', 'server'));
const args = [command];
if (command === 'start') args.push('--host', '127.0.0.1', '--port', productionPort(process.env.PORT));
const child = spawn(join(root, 'node_modules', '.bin', 'medusa'), args, {
  cwd: workingDirectory,
  env: { ...process.env, MEDUSA_DISABLE_TELEMETRY: 'true' },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
