import { resolve } from 'node:path';

if (process.platform !== 'linux' || process.getuid() === 0 || process.argv.length !== 3 ||
    !/^[0-9a-f]{40}$/.test(process.argv[2] || '')) {
  throw new Error('First production backup requires an exact release and the unprivileged backup account.');
}
const expectedDirectory = `/srv/pawshop-commerce/releases/${process.argv[2]}/_commerce`;
if (resolve(process.cwd()) !== expectedDirectory) {
  throw new Error('First production backup must run from the exact immutable release.');
}
await import('./backup-production.mjs');
await import('./sync-production-backups.mjs');
