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

import { chmodSync, realpathSync, renameSync, writeFileSync } from 'node:fs';

// Created and made writable by StateDirectory=pawshop-backup in the unit, which
// is also what lets this write succeed under ProtectSystem=strict. The monitor
// reads the same path from PAWSHOP_MONITOR_BACKUP_TIMESTAMP_FILE.
const BACKUP_TIMESTAMP_FILE = '/var/lib/pawshop-backup/last-success.txt';

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

// Only reached when the dump and the offsite upload both succeeded, so the file
// means exactly "the last fully successful scheduled backup", which is the
// question the freshness check asks.
//
// Why a file exists at all: systemd only knows about runs since the host booted.
// A reboot before the daily 03:20 run therefore left the monitor with an empty
// completion timestamp and it reported a failure that had not happened, once per
// reboot. The recorded instant outlives the boot, while the unit's own Result
// keeps reporting a genuine failure within minutes - the monitor reads both.
//
// The instant is not a secret, and the monitor runs as a different account, so
// the file is deliberately world-readable: UMask=0077 in the unit would
// otherwise create it 0600 and the check would only ever see "unreadable". The
// staged-then-renamed write means a reader never observes a half-written file.
const recordedAt = `${new Date().toISOString()}\n`;
const stagedTimestamp = `${BACKUP_TIMESTAMP_FILE}.staged`;
writeFileSync(stagedTimestamp, recordedAt, { mode: 0o644 });
chmodSync(stagedTimestamp, 0o644);
renameSync(stagedTimestamp, BACKUP_TIMESTAMP_FILE);
