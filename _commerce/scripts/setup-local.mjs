import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ensurePrivateRuntime } = require('./private-runtime.cjs');
const { validateLocalEnvironment } = require('../src/lib/local-policy.cjs');
const runtime = ensurePrivateRuntime();
validateLocalEnvironment({ ...process.env, ...runtime.env, NODE_ENV: 'development' });

const pgBin = '/opt/homebrew/opt/postgresql@17/bin';
const tool = name => `${pgBin}/${name}`;
if (!existsSync(tool('initdb'))) throw new Error('PostgreSQL 17 is missing. Install it with Homebrew first.');

function run(name, args, options = {}) {
  execFileSync(tool(name), args, { stdio: 'inherit', ...options });
}

if (!existsSync(`${runtime.dataDir}/PG_VERSION`)) {
  const passwordFile = `${runtime.privateDir}/.postgres-password.tmp`;
  writeFileSync(passwordFile, `${runtime.env.POSTGRES_PASSWORD}\n`, { mode: 0o600 });
  try {
    run('initdb', [
      '-D', runtime.dataDir,
      '--username=pawshop',
      '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256',
      `--pwfile=${passwordFile}`,
      '--encoding=UTF8',
      '--locale=C',
    ]);
    writeFileSync(`${runtime.dataDir}/postgresql.conf`, [
      readFileSync(`${runtime.dataDir}/postgresql.conf`, 'utf8'),
      "listen_addresses = '127.0.0.1'",
      'port = 54329',
      `unix_socket_directories = '${runtime.socketDir.replaceAll("'", "''")}'`,
      "password_encryption = 'scram-sha-256'",
      '',
    ].join('\n'));
    chmodSync(`${runtime.dataDir}/postgresql.conf`, 0o600);
  } finally {
    rmSync(passwordFile, { force: true });
  }
}

const ready = () => spawnSync(tool('pg_isready'), ['-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop'], { stdio: 'ignore' }).status === 0;
if (!ready()) run('pg_ctl', ['-D', runtime.dataDir, '-l', runtime.logFile, 'start']);

for (let attempt = 0; attempt < 30 && !ready(); attempt += 1) {
  execFileSync('/bin/sleep', ['0.2']);
}
if (!ready()) throw new Error(`Dedicated PostgreSQL did not become ready. See ${runtime.logFile}`);

const dbEnv = { ...process.env, PGPASSWORD: runtime.env.POSTGRES_PASSWORD };
const actualDataDir = execFileSync(tool('psql'), [
  '-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', '-d', 'postgres', '-tAc', 'SHOW data_directory',
], { env: dbEnv, encoding: 'utf8' }).trim();
if (actualDataDir !== runtime.dataDir) throw new Error(`Port 54329 belongs to a different PostgreSQL cluster: ${actualDataDir}`);
const exists = execFileSync(tool('psql'), [
  '-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', '-d', 'postgres',
  '-tAc', "SELECT 1 FROM pg_database WHERE datname = 'pawshop_dev'",
], { env: dbEnv, encoding: 'utf8' }).trim() === '1';
if (!exists) run('createdb', ['-h', '127.0.0.1', '-p', '54329', '-U', 'pawshop', 'pawshop_dev'], { env: dbEnv });

console.log('PawShop private runtime and dedicated loopback database are ready.');
console.log(`Credentials remain private in: ${runtime.privateDir}`);
