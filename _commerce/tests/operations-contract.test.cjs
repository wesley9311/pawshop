'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { backupManifestHmac, constrainedBackupPath, equalHex } = require('../scripts/backup-integrity.cjs');

const root = resolve(__dirname, '..');
const backup = readFileSync(resolve(root, 'scripts/backup-real.mjs'), 'utf8');
const restore = readFileSync(resolve(root, 'scripts/restore-verify-real.mjs'), 'utf8');
const runtime = readFileSync(resolve(root, 'scripts/private-runtime.cjs'), 'utf8');
const productionVerifier = readFileSync(resolve(root, 'scripts/verify-production-admin.mjs'), 'utf8');
const productionBackup = readFileSync(resolve(root, 'scripts/backup-production.mjs'), 'utf8');
const productionRestore = readFileSync(resolve(root, 'scripts/restore-verify-production.mjs'), 'utf8');
const productionWait = readFileSync(resolve(root, 'scripts/wait-production-admin.mjs'), 'utf8');
const commerceService = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-commerce.service'), 'utf8');
const backupService = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-backup.service'), 'utf8');
const restoreService = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-restore-verify.service'), 'utf8');

test('real backup is encrypted and plaintext is removed', () => {
  assert.match(backup, /aes-256-cbc/);
  assert.match(backup, /-pbkdf2/);
  assert.match(backup, /rmSync\(plainTemp/);
  assert.match(backup, /hmac_sha256/);
  assert.match(backup, /atomicPrivateWrite/);
  assert.doesNotMatch(backup, /customers:\s*0|orders:\s*0|Expected one approved source product/);
  assert.doesNotMatch(backup, /criticalDataSha256|SELECT count\(\*\)/);
});

test('real restore authenticates paths and cleans the temporary database', () => {
  assert.match(restore, /constrainedBackupPath/);
  assert.match(restore, /hmac_sha256/);
  assert.match(restore, /dropdb/);
  assert.match(restore, /PAWSHOP_KEEP_RESTORE_DB/);
  assert.match(restore, /pawshop-real-restore-verification-v2/);
  assert.match(restore, /critical_data_sha256/);
  assert.match(restore, /AggregateError/);
  assert.ok(restore.indexOf('dropdb') < restore.indexOf('writeFileSync(verificationTemporary'));
});

test('backup key loss cannot silently replace a key for existing backups', () => {
  assert.match(runtime, /hasEncryptedBackups/);
  assert.match(runtime, /Existing backups must not be overwritten with a new key/);
  assert.doesNotMatch(runtime, /if \(!existsSync\(backupKeyFile\)\) secureWrite/);
});

test('backup path and digest comparisons reject unsafe values', () => {
  assert.equal(constrainedBackupPath('/private/backups', '/private/backups/a.enc', 'backup'), '/private/backups/a.enc');
  assert.throws(() => constrainedBackupPath('/private/backups', '/private/escape.enc', 'backup'));
  assert.equal(equalHex('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(equalHex('a'.repeat(64), 'b'.repeat(64)), false);
  assert.equal(equalHex('invalid', 'invalid'), false);
});

test('production manifest authentication covers archive identity and provenance', () => {
  const key = Buffer.alloc(32, 7);
  const manifest = {
    schema: 'pawshop-production-backup-v1', created_at: '2026-09-08T00:00:00.000Z',
    source_database: 'pawshop', encrypted_file: 'pawshop_production_20260908T000000000Z.dump.enc',
    encryption: 'AES-256-CBC PBKDF2', sha256: 'a'.repeat(64), hmac_sha256: 'b'.repeat(64), size_bytes: 123,
  };
  const signed = backupManifestHmac(manifest, key);
  assert.equal(signed.length, 64);
  for (const field of ['created_at', 'source_database', 'encrypted_file', 'sha256', 'hmac_sha256', 'size_bytes']) {
    assert.notEqual(backupManifestHmac({ ...manifest, [field]: `${manifest[field]}x` }, key), signed);
  }
});

test('production admin verifier keeps customer commerce closed', () => {
  assert.match(productionVerifier, /\/admin\/products/);
  assert.match(productionVerifier, /\/admin\/orders/);
  assert.match(productionVerifier, /\/store\/products/);
  assert.match(productionVerifier, /\/store\/carts/);
  assert.match(productionVerifier, /\/auth\/customer\/emailpass\/register/);
  assert.match(productionVerifier, /503/);
  assert.match(productionVerifier, /pawshop-runtime/);
  assert.match(productionVerifier, /assertLoopbackListeners/);
  assert.match(productionVerifier, /validateProductionEnvironment/);
  assert.doesNotMatch(productionVerifier, /publishable|authorization|cookie/i);
});

test('production backup encrypts data and suppresses database command output', () => {
  assert.match(productionBackup, /pg_dump/);
  assert.match(productionBackup, /aes-256-cbc/);
  assert.match(productionBackup, /hmac_sha256/);
  assert.match(productionBackup, /manifest_hmac_sha256/);
  assert.match(productionBackup, /basename\(encryptedFile\)/);
  assert.match(productionBackup, /pipeline\(dump\.stdout, encrypt\.stdin\)/);
  assert.match(productionBackup, /assertBackupDirectoryStat\(lstatSync\(backupDir\), process\.getuid\(\)\)/);
  assert.match(productionBackup, /openSync\(encryptedTemp, 'wx', 0o600\)/);
  assert.doesNotMatch(productionBackup, /plainTemp|\.dump\.tmp|--file|-out/);
  assert.deepEqual(
    [...productionBackup.matchAll(/console\.log\(([^)]*)\)/g)].map(match => match[1]),
    ["'Encrypted production database backup completed.'"],
  );
});

test('production restore streams decrypted data into an isolated database and always removes it', () => {
  assert.match(productionRestore, /pawshop-production-backup-v1/);
  assert.match(productionRestore, /digestFile\(encryptedFile/);
  assert.match(productionRestore, /manifest_hmac_sha256/);
  assert.match(productionRestore, /pipeline\(decrypt\.stdout, restore\.stdin\)/);
  assert.match(productionRestore, /\/usr\/lib\/postgresql\/17\/bin/);
  assert.match(productionRestore, /initdb/);
  assert.match(productionRestore, /'-l', postgresLog/);
  assert.match(productionRestore, /postgresStartAttempted = true/);
  assert.match(productionRestore, /postgresStartAttempted && postgresIsRunning\(\)/);
  assert.match(productionRestore, /listen_addresses=/);
  assert.match(productionRestore, /openSync\(lockFile, 'wx'/);
  assert.match(productionRestore, /operationDeadline/);
  assert.match(productionRestore, /requiredBytes/);
  assert.match(productionRestore, /isolated_cluster_removed: true/);
  assert.match(productionRestore, /critical_table_counts/);
  assert.match(productionRestore, /manifest\.size_bytes !== encryptedStat\.size/);
  assert.match(productionRestore, /\/var\/lib\/pawshop-restore/);
  assert.doesNotMatch(productionRestore, /plainDump|\.dump\.tmp|PAWSHOP_KEEP_RESTORE_DB|runuser|dropdb/);
  assert.match(restoreService, /^User=pawshop-restore$/m);
  assert.match(restoreService, /^ExecStart=\/usr\/bin\/node \/usr\/local\/libexec\/pawshop\/restore-verify-production\.mjs$/m);
  assert.match(restoreService, /^KillMode=control-group$/m);
  assert.match(restoreService, /^RestrictAddressFamilies=AF_UNIX$/m);
  assert.match(restoreService, /^TimeoutStartSec=15min$/m);
  assert.match(restoreService, /^CapabilityBoundingSet=$/m);
  assert.match(restoreService, /^IPAddressDeny=any$/m);
  assert.match(restoreService, /^ReadWritePaths=\/var\/lib\/pawshop-restore\/work \/var\/lib\/pawshop-restore\/verifications$/m);
  assert.doesNotMatch(restoreService, /EnvironmentFile/);
});

test('systemd service is unprivileged, hardened, and verifies startup', () => {
  assert.match(commerceService, /^User=pawshop$/m);
  assert.match(commerceService, /^NoNewPrivileges=true$/m);
  assert.match(commerceService, /^ProtectSystem=strict$/m);
  assert.match(commerceService, /^CapabilityBoundingSet=$/m);
  assert.match(commerceService, /wait-production-admin\.mjs/);
  assert.match(commerceService, /^TimeoutStartSec=180s$/m);
  assert.match(productionWait, /Date\.now\(\) \+ 120000/);
  assert.match(productionWait, /verifierTimeoutMs = 5000/);
  assert.match(backupService, /^TimeoutStartSec=10min$/m);
  assert.doesNotMatch(commerceService, /0\.0\.0\.0|--host\s+::/);
});
