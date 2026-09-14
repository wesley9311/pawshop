import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertProductionEnvironmentFileStat, parseProductionEnvironmentFile } = require('./production-env-file.cjs');
const { validateProductionEnvironment } = require('../src/lib/production-policy.cjs');

if (process.platform !== 'linux' || process.getuid() === 0 || process.argv.length !== 2) {
  throw new Error('First production migration must run as the unprivileged PawShop service account.');
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (!/^\/srv\/pawshop-commerce\/releases\/[0-9a-f]{40}\/_commerce$/.test(root)) {
  throw new Error('First production migration must run from an exact immutable release.');
}
const environmentFile = '/etc/pawshop/commerce.env';
assertProductionEnvironmentFileStat(lstatSync(environmentFile), process.getgid());
const environment = parseProductionEnvironmentFile(readFileSync(environmentFile, 'utf8'));
validateProductionEnvironment(environment);
if (environment.PAWSHOP_MIGRATIONS_CONFIRMED !== '0') {
  throw new Error('First production migration requires the fail-closed migration gate.');
}

const child = spawn(join(root, 'node_modules', '.bin', 'medusa'), ['db:migrate'], {
  cwd: root,
  env: {
    HOME: '/var/lib/pawshop', LANG: 'C.UTF-8', PATH: '/usr/bin:/bin',
    NODE_OPTIONS: '--max-old-space-size=768', MEDUSA_DISABLE_TELEMETRY: 'true',
    ...environment,
  },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
