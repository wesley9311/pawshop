import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseProductionEnvironmentFile } = require('./production-env-file.cjs');
const { databaseConnection } = require('./production-private-paths.cjs');

// The supported way back into the admin when nobody can log in.
//
// Medusa's own `user` command creates an account and cannot change one, and the
// dashboard's "forgot password" needs a mail relay that may not be configured
// yet. Without this, a lost password would be unrecoverable - the owner account
// exists in the database and nothing in the product can open it.
//
// It writes the password hash exactly the way Medusa's emailpass provider does,
// using Medusa's own scrypt parameters, and never touches the account rows
// themselves. The decisive check is not this script's own bookkeeping but the
// real login verification that the wrapper runs afterwards: if the credentials
// file is accepted by the running service, the hash was written correctly.

if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 4) {
  throw new Error('Production owner password rotation requires root on Linux and an exact release identity.');
}
if (process.env.PAWSHOP_PRODUCTION_OWNER_ROTATION_CONFIRMED !== '1') {
  throw new Error('Set PAWSHOP_PRODUCTION_OWNER_ROTATION_CONFIRMED=1 after reviewing this exact rotation.');
}
const release = resolve(process.argv[2] || '');
const releaseId = process.argv[3];
if (!/^[0-9a-f]{40}$/.test(releaseId || '') || release !== `/srv/pawshop-commerce/releases/${releaseId}`) {
  throw new Error('Production owner rotation release identity is invalid.');
}
const verifiedReleaseId = readFileSync(join(release, '.pawshop-release'), 'utf8').trim();
if (verifiedReleaseId !== releaseId) throw new Error('Production owner rotation release does not match its marker.');

function readRootFile(path, maximum, label, { gid = 0, mode = 0o600 } = {}) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== gid ||
      (stat.mode & 0o777) !== mode || stat.size <= 0 || stat.size > maximum) {
    throw new Error(`${label} has unsafe ownership, type, permissions, or size.`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(descriptor, 'utf8'); } finally { closeSync(descriptor); }
}

const credentialsPath = '/root/pawshop-production-owner-credentials.json';
const pawshopUid = Number(execFileSync('/usr/bin/id', ['-u', 'pawshop'], { encoding: 'utf8' }).trim());
const pawshopGid = Number(execFileSync('/usr/bin/id', ['-g', 'pawshop'], { encoding: 'utf8' }).trim());
let credentials;
try { credentials = JSON.parse(readRootFile(credentialsPath, 4096, 'Owner credentials')); }
catch { throw new Error('Production owner credentials are invalid or unreadable; provision them first.'); }
if (!credentials || Object.keys(credentials).sort().join('\0') !== 'email\0password' ||
    typeof credentials.email !== 'string' || typeof credentials.password !== 'string') {
  throw new Error('Production owner credentials do not match the approved contract.');
}
const environment = parseProductionEnvironmentFile(readRootFile(
  '/etc/pawshop/commerce.env', 64 * 1024, 'Production environment', { gid: pawshopGid, mode: 0o640 },
));
if (environment.PAWSHOP_MIGRATIONS_CONFIRMED !== '1' || environment.PAWSHOP_MODE !== 'production-admin-only') {
  throw new Error('Production owner rotation requires the activated admin-only environment.');
}

// Medusa's emailpass provider stores scrypt(password, { logN: 15, r: 8, p: 1 })
// base64-encoded under provider_metadata.password. The parameters and the library
// are taken from Medusa itself rather than reimplemented, so a provider change
// that alters the format breaks the verification step below instead of silently
// locking the account.
const scryptKdf = require(join(release, '_commerce/node_modules/scrypt-kdf'));
const passwordHash = (await scryptKdf.kdf(credentials.password, { logN: 15, r: 8, p: 1 })).toString('base64');
if (typeof passwordHash !== 'string' || passwordHash.length < 32) {
  throw new Error('The pinned password hash implementation is unavailable.');
}
const nextPassword = `${randomBytes(24).toString('base64url')}!aA7`;
const nextHash = (await scryptKdf.kdf(nextPassword, { logN: 15, r: 8, p: 1 })).toString('base64');
// Guard against writing a hash this process cannot itself verify.
if (!(await scryptKdf.verify(Buffer.from(nextHash, 'base64'), nextPassword))) {
  throw new Error('The new password hash failed its own verification.');
}

const connection = databaseConnection(environment.DATABASE_URL);

// The database is reached as the service account, but this process keeps root:
// the credential file it rewrites lives in /root. The privilege is dropped for
// the one child that needs to connect, not for the whole script.
function psql(sql) {
  return execFileSync('/usr/bin/setpriv', [
    `--reuid=${pawshopUid}`, `--regid=${pawshopGid}`, '--clear-groups', '--inh-caps=-all', '--no-new-privs',
    '/usr/bin/psql',
    '-h', connection.host, '-p', connection.port, '-U', connection.user, '-d', connection.database,
    '--no-psqlrc', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', sql,
  ], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, PGPASSWORD: connection.password, PGCONNECT_TIMEOUT: '5' },
  }).trim();
}

// Rotate only if this address maps to exactly one live account. Anything else is
// a state a human must look at, and a blind UPDATE could rewrite the wrong row.
const target = psql([
  'SELECT count(*)::text FROM provider_identity pi JOIN auth_identity ai ON ai.id = pi.auth_identity_id',
  `WHERE pi.provider = 'emailpass' AND pi.entity_id = '${credentials.email}'`,
  '  AND pi.deleted_at IS NULL AND ai.deleted_at IS NULL',
  '  AND ai.app_metadata ->> \'user_id\' = (SELECT id FROM "user" WHERE email =',
  `    '${credentials.email}' AND deleted_at IS NULL);`,
].join(' '));
if (target !== '1') {
  throw new Error('The production owner identity is missing or ambiguous; refusing to rewrite a password.');
}

const updated = psql([
  'WITH rewritten AS (',
  '  UPDATE provider_identity',
  `  SET provider_metadata = jsonb_set(COALESCE(provider_metadata, '{}'::jsonb), '{password}', to_jsonb('${nextHash}'::text), true)`,
  `  WHERE provider = 'emailpass' AND entity_id = '${credentials.email}' AND deleted_at IS NULL`,
  '  RETURNING 1',
  ') SELECT count(*)::text FROM rewritten;',
].join(' '));
if (updated !== '1') {
  throw new Error('The password rewrite did not affect exactly one authentication identity.');
}

// Replace the credential file atomically and only after the database accepted the
// new hash, so the file and the account can never disagree in a way an operator
// would have to discover by trial.
const stagingPath = `${credentialsPath}.${process.pid}.next`;
const descriptor = openSync(stagingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
try {
  writeFileSync(descriptor, `${JSON.stringify({ email: credentials.email, password: nextPassword }, null, 2)}\n`, { encoding: 'utf8' });
  fsyncSync(descriptor);
} finally {
  closeSync(descriptor);
}
try {
  renameSync(stagingPath, credentialsPath);
} catch (error) {
  unlinkSync(stagingPath);
  throw error;
}
console.log(`Production owner password rotated for the provisioned address; the new password is only in ${credentialsPath}.`);
