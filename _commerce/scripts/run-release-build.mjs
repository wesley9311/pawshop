import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { validateProductionEnvironment } = require('../src/lib/production-policy.cjs');

if (process.platform !== 'linux' || process.getuid() === 0) {
  throw new Error('Production release builds require an isolated unprivileged Ubuntu build account.');
}
// Build-only values pass the same production shape checks without exposing live
// database, Redis, cookie, JWT, or object-storage credentials to npm lifecycle code.
const buildEnv = {
  NODE_ENV: 'production', PAWSHOP_MODE: 'production-admin-only',
  PAWSHOP_INFRA_TOPOLOGY: 'single-host-private', PAWSHOP_MIGRATIONS_CONFIRMED: '0',
  DATABASE_URL: 'postgresql://build_fixture:not-a-credential@127.0.0.1:5432/pawshop?sslmode=disable',
  REDIS_URL: 'redis://build_fixture:not-a-credential@127.0.0.1:6379/0',
  JWT_SECRET: 'a'.repeat(64), COOKIE_SECRET: 'b'.repeat(64),
  STOREFRONT_ORIGIN: 'https://pawlivora.com', ADMIN_ORIGIN: 'http://127.0.0.1:9000',
  MEDUSA_WORKER_MODE: 'shared', PORT: '9000',
  S3_FILE_URL: 'https://media.invalid/pawshop', S3_ACCESS_KEY_ID: 'build-fixture',
  S3_SECRET_ACCESS_KEY: 'not-a-real-secret-value', S3_REGION: 'build-region',
  S3_BUCKET: 'build-fixture', S3_ENDPOINT: 'https://s3.invalid',
  S3_FORCE_PATH_STYLE: '0', S3_DISABLE_ACL: '1',
};
validateProductionEnvironment(buildEnv);

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn('/usr/bin/npm', ['run', 'build:production'], {
  cwd: projectRoot,
  env: {
    HOME: '/var/cache/pawshop-build', LANG: 'C.UTF-8', PATH: '/usr/bin:/bin',
    NODE_OPTIONS: '--max-old-space-size=1024',
    npm_config_cache: '/var/cache/pawshop-build/npm', ...buildEnv,
  },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', () => reject(new Error('Production release build could not start.')));
  child.once('exit', code => resolve(code ?? 1));
});
if (exitCode !== 0) throw new Error('Production release build failed.');
