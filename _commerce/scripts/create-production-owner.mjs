import { execFileSync } from 'node:child_process';
import { constants, lstatSync, openSync, closeSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseProductionEnvironmentFile } = require('./production-env-file.cjs');
const { databaseConnection } = require('./production-private-paths.cjs');

if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 4) {
  throw new Error('Production owner creation requires root on Linux and an exact release identity.');
}
const release = resolve(process.argv[2] || '');
const releaseId = process.argv[3];
if (!/^[0-9a-f]{40}$/.test(releaseId || '') || release !== `/srv/pawshop-commerce/releases/${releaseId}`) {
  throw new Error('Production owner release identity is invalid.');
}
const verifiedReleaseId = readFileSync(join(release, '.pawshop-release'), 'utf8').trim();
if (verifiedReleaseId !== releaseId) throw new Error('Production owner creation release does not match its marker.');

function readRootFile(path, maximum, label, { gid = 0, mode = 0o600 } = {}) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== gid ||
      (stat.mode & 0o777) !== mode || stat.size <= 0 || stat.size > maximum) {
    throw new Error(`${label} has unsafe ownership, type, permissions, or size.`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(descriptor, 'utf8'); } finally { closeSync(descriptor); }
}

const pawshopUid = Number(execFileSync('/usr/bin/id', ['-u', 'pawshop'], { encoding: 'utf8' }).trim());
const pawshopGid = Number(execFileSync('/usr/bin/id', ['-g', 'pawshop'], { encoding: 'utf8' }).trim());
let credentials;
try { credentials = JSON.parse(readRootFile('/root/pawshop-production-owner-credentials.json', 4096, 'Owner credentials')); }
catch { throw new Error('Production owner credentials are invalid or unreadable.'); }
if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
    Object.keys(credentials).sort().join('\0') !== 'email\0password' ||
    !/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\.[a-z]{2,24}$/.test(credentials.email || '') ||
    typeof credentials.password !== 'string' || credentials.password.length < 32 || credentials.password.length > 128) {
  throw new Error('Production owner credentials do not match the approved contract.');
}
const environment = parseProductionEnvironmentFile(readRootFile(
  '/etc/pawshop/commerce.env', 64 * 1024, 'Production environment', { gid: pawshopGid, mode: 0o640 },
));
if (environment.PAWSHOP_MIGRATIONS_CONFIRMED !== '1' || environment.PAWSHOP_MODE !== 'production-admin-only') {
  throw new Error('Production owner creation requires the activated admin-only environment.');
}
Object.assign(process.env, environment, { MEDUSA_DISABLE_TELEMETRY: 'true', HOME: '/var/lib/pawshop' });
process.chdir(join(release, '_commerce'));
process.setgroups([pawshopGid]);
process.setgid(pawshopGid);
process.setuid(pawshopUid);

const connection = databaseConnection(environment.DATABASE_URL);
const existing = execFileSync('/usr/bin/psql', [
  '-h', connection.host, '-p', connection.port, '-U', connection.user, '-d', connection.database,
  '--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1',
  '--command', [
    'SELECT',
    '  (SELECT count(*) FROM "user" WHERE email =', `'${credentials.email}' AND deleted_at IS NULL)::text`, '||', "':'", '||',
    '  (SELECT count(*) FROM provider_identity pi JOIN auth_identity ai ON ai.id = pi.auth_identity_id',
    `   WHERE pi.provider = 'emailpass' AND pi.entity_id = '${credentials.email}'`,
    '   AND pi.deleted_at IS NULL AND ai.deleted_at IS NULL',
    `   AND ai.app_metadata ->> 'user_id' = (SELECT id FROM "user" WHERE email = '${credentials.email}' AND deleted_at IS NULL))::text;`,
  ].join(' '),
], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...process.env, PGPASSWORD: connection.password, PGCONNECT_TIMEOUT: '5' },
}).trim();
if (existing === '1:1') {
  console.log('The production owner user and its authentication identity already exist; no credential was changed.');
  process.exit(0);
}
if (existing !== '0:0') {
  throw new Error('Production owner state is partial or conflicting. Preserve it and review user, provider_identity, and auth_identity before retrying.');
}

const commandPath = join(release, '_commerce/node_modules/@medusajs/medusa/dist/commands/user.js');
const createUser = require(commandPath).default;
if (typeof createUser !== 'function') throw new Error('The pinned Medusa owner command is unavailable.');
await createUser({
  directory: join(release, '_commerce'), email: credentials.email, password: credentials.password,
  keepAlive: false, invite: false,
});
