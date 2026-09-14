import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs';

if (process.platform !== 'linux' || process.getuid() !== 0 || process.argv.length !== 3) {
  throw new Error('Production owner credential provisioning requires root on Linux and one email address.');
}
const email = process.argv[2].toLowerCase();
if (!/^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\.[a-z]{2,24}$/.test(email)) {
  throw new Error('Production owner email address is invalid.');
}
const path = '/root/pawshop-production-owner-credentials.json';
const password = `${randomBytes(24).toString('base64url')}!aA7`;
const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
try {
  writeFileSync(descriptor, `${JSON.stringify({ email, password }, null, 2)}\n`, { encoding: 'utf8' });
  fsyncSync(descriptor);
} finally {
  closeSync(descriptor);
}
chmodSync(path, 0o600);
console.log(`Production owner credentials created at ${path}; the password was not printed.`);
