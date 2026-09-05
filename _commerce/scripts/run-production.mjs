import { join, dirname } from 'node:path';
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
const args = [command];
if (command === 'start') args.push('--host', '127.0.0.1', '--port', productionPort(process.env.PORT));
const child = spawn(join(root, 'node_modules', '.bin', 'medusa'), args, {
  cwd: root,
  env: { ...process.env, MEDUSA_DISABLE_TELEMETRY: 'true' },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
