// Entry point for the scheduled encrypted backup: one main process runs the
// dump and then the offsite upload, in that order.
//
// Why both steps share a single main process instead of using ExecStartPost:
// the offsite upload must read its object storage credentials from the systemd
// credential directory, and a unit that takes a private mount namespace (any of
// ProtectSystem=strict, ProtectHome, PrivateTmp or the ProtectKernel* options -
// all of which this unit sets) cannot read its own loaded credentials from an
// ExecStartPost process. The read fails with EACCES, so every scheduled backup
// produced a local encrypted dump and then failed at the upload, leaving the
// offsite copy silently behind while the unit reported failure. A process
// started as ExecStart reads the same credentials without any trouble, which is
// why the first-backup drill (run-first-production-backup.mjs) always worked:
// it composes these two scripts exactly like this.
//
// The two imports are deliberately sequential and both are already
// unprivileged, release-local modules that validate their own environment.

import { realpathSync } from 'node:fs';

if (process.platform !== 'linux' || process.getuid() === 0) {
  throw new Error('The scheduled production backup requires the unprivileged backup account.');
}
// The unit starts in /srv/pawshop-commerce/current/_commerce. Both sides are
// resolved so the check holds whether the kernel reports the working directory
// as the activated link or as the release it points at: a backup must never run
// from anything but the release that is currently active.
const activeReleaseDirectory = realpathSync('/srv/pawshop-commerce/current/_commerce');
if (realpathSync(process.cwd()) !== activeReleaseDirectory) {
  throw new Error('The scheduled production backup must run from the active immutable release.');
}

await import('./backup-production.mjs');
await import('./sync-production-backups.mjs');
