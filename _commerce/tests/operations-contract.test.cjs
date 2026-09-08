'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { assertProductionBackupManifest, backupManifestHmac, constrainedBackupPath, equalHex } = require('../scripts/backup-integrity.cjs');

const root = resolve(__dirname, '..');
const backup = readFileSync(resolve(root, 'scripts/backup-real.mjs'), 'utf8');
const restore = readFileSync(resolve(root, 'scripts/restore-verify-real.mjs'), 'utf8');
const runtime = readFileSync(resolve(root, 'scripts/private-runtime.cjs'), 'utf8');
const productionVerifier = readFileSync(resolve(root, 'scripts/verify-production-admin.mjs'), 'utf8');
const productionBackup = readFileSync(resolve(root, 'scripts/backup-production.mjs'), 'utf8');
const productionRestore = readFileSync(resolve(root, 'scripts/restore-verify-production.mjs'), 'utf8');
const productionWait = readFileSync(resolve(root, 'scripts/wait-production-admin.mjs'), 'utf8');
const offsiteSync = readFileSync(resolve(root, 'scripts/sync-production-backups.mjs'), 'utf8');
const offsiteClient = readFileSync(resolve(root, 'scripts/offsite-s3-client.cjs'), 'utf8');
const commerceService = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-commerce.service'), 'utf8');
const backupService = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-backup.service'), 'utf8');
const restoreService = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-restore-verify.service'), 'utf8');
const hostBootstrap = readFileSync(resolve(root, '..', 'ops/commerce/bootstrap-ubuntu-host.sh'), 'utf8');
const identityProvisioner = readFileSync(resolve(root, '..', 'ops/commerce/provision-production-identities.sh'), 'utf8');

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
  const complete = { ...manifest, manifest_hmac_sha256: signed };
  assert.doesNotThrow(() => assertProductionBackupManifest(complete, 'pawshop_production_20260908T000000000Z.manifest.json'));
  assert.throws(() => assertProductionBackupManifest({ ...complete, extra: true }));
  assert.throws(() => assertProductionBackupManifest(complete, 'pawshop_production_20260909T000000000Z.manifest.json'));
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
  assert.match(productionRestore, /assertProductionBackupManifest/);
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
  assert.match(commerceService, /^Environment=NODE_OPTIONS=--max-old-space-size=768$/m);
  assert.match(commerceService, /^MemoryHigh=1G$/m);
  assert.match(commerceService, /^MemoryMax=1200M$/m);
  assert.match(productionWait, /Date\.now\(\) \+ 120000/);
  assert.match(productionWait, /verifierTimeoutMs = 5000/);
  assert.match(backupService, /^TimeoutStartSec=30min$/m);
  assert.match(backupService, /^User=pawshop-backup$/m);
  assert.match(backupService, /^EnvironmentFile=\/etc\/pawshop-backup\/backup\.env$/m);
  assert.match(commerceService, /^InaccessiblePaths=-\/var\/backups\/pawshop -\/etc\/pawshop-backup$/m);
  assert.doesNotMatch(commerceService, /0\.0\.0\.0|--host\s+::/);
});

test('Ubuntu bootstrap pins supply chain and keeps data services private', () => {
  assert.match(hostBootstrap, /node_version=22\.23\.2/);
  assert.match(hostBootstrap, /node_sha256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307/);
  assert.match(hostBootstrap, /pgdg_fingerprint=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8/);
  assert.match(hostBootstrap, /primary_fingerprints != "\$pgdg_fingerprint"/);
  assert.match(hostBootstrap, /postgresql-17 postgresql-client-17/);
  assert.match(hostBootstrap, /listen_addresses = '127\.0\.0\.1'/);
  assert.match(hostBootstrap, /--bind 127\.0\.0\.1/);
  assert.match(hostBootstrap, /--maxmemory 96mb/);
  assert.match(hostBootstrap, /shared_buffers = '128MB'/);
  assert.match(hostBootstrap, /max_connections = 40/);
  assert.match(hostBootstrap, /actual_listeners != "\$expected_listeners"/);
  assert.match(hostBootstrap, /for unit in postgresql@17-main\.service redis-server\.service/);
  assert.match(hostBootstrap, /systemctl stop "\$unit"/);
  assert.match(hostBootstrap, /systemctl disable "\$unit"/);
  assert.match(hostBootstrap, /policy_rc_path=\/usr\/sbin\/policy-rc\.d/);
  assert.match(hostBootstrap, /exit 101/);
  assert.match(hostBootstrap, /runtime_mutation_started=1[\s\S]*apt-get install/);
  assert.match(hostBootstrap, /enabled_state == disabled \|\| \$enabled_state == not-found/);
  assert.match(hostBootstrap, /CRITICAL: bootstrap failed and PostgreSQL\/Redis containment or policy-rc\.d removal was not verified/);
  assert.match(hostBootstrap, /systemctl is-active --quiet "\$unit"/);
  assert.match(hostBootstrap, /Existing system account does not match the approved identity/);
  assert.match(hostBootstrap, /The approved system group is shared by another account/);
  assert.match(hostBootstrap, /-n \$group_members/);
  assert.match(hostBootstrap, /diff --brief --recursive --no-dereference/);
  assert.match(hostBootstrap, /Medusa, database roles, migrations, customer APIs, backups and payments remain inactive/);
  assert.doesNotMatch(hostBootstrap, /commerce\.env|backup\.key|CREATE ROLE|db:migrate|systemctl enable.*pawshop-commerce/);
});

test('production identity provisioning is private, fail-closed, and keeps OSS incomplete', () => {
  assert.match(identityProvisioner, /^set \+x$/m);
  assert.match(identityProvisioner, /Existing production identity artifact requires an explicit recovery review/);
  assert.match(identityProvisioner, /flock -n 9/);
  assert.match(identityProvisioner, /CREATE ROLE pawshop LOGIN PASSWORD/);
  assert.match(identityProvisioner, /CREATE ROLE pawshop_backup LOGIN PASSWORD/);
  assert.match(identityProvisioner, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
  assert.match(identityProvisioner, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO pawshop_backup/);
  assert.doesNotMatch(identityProvisioner, /pg_read_all_data/);
  assert.match(identityProvisioner, /user default off/);
  assert.match(identityProvisioner, /user pawshop on #\$redis_password_hash/);
  assert.match(identityProvisioner, /--aclfile \/etc\/pawshop-redis\/users\.acl/);
  assert.match(identityProvisioner, /install -d -o root -g redis -m 0750 "\$redis_acl_dir"/);
  assert.match(identityProvisioner, /anonymous_redis != 'NOAUTH Authentication required\.'/);
  assert.match(identityProvisioner, /REDISCLI_AUTH="\$redis_password"/);
  assert.match(identityProvisioner, /CRITICAL: identity rollback could not be verified/);
  assert.match(identityProvisioner, /runuser -u postgres -- psql[\s\S]*< "\$sql_file"/);
  assert.match(identityProvisioner, /app_role_created=1/);
  assert.match(identityProvisioner, /recovery-secrets\.txt/);
  assert.match(identityProvisioner, /validate_system_account pawshop \/var\/lib\/pawshop/);
  assert.match(identityProvisioner, /validate_private_directory \/etc\/pawshop root pawshop 750/);
  assert.match(identityProvisioner, /install -o root -g root -m 0600.*owner-credentials\.txt/);
  assert.match(identityProvisioner, /RAM user\/access key: PENDING/);
  assert.match(identityProvisioner, /commerce\.env and Medusa stay inactive/);
  assert.doesNotMatch(identityProvisioner, /S3_SECRET_ACCESS_KEY=/);
  assert.doesNotMatch(identityProvisioner, /systemctl enable.*pawshop-commerce/);
});

test('offsite sync is versioned, read-back verified, credential isolated, and never deletes remote objects', () => {
  assert.match(offsiteSync, /assertVersioningEnabled/);
  assert.match(offsiteSync, /manifest_hmac_sha256/);
  assert.match(offsiteSync, /receipt_hmac_sha256/);
  assert.match(offsiteSync, /selectLocalPruneCandidates/);
  assert.match(offsiteSync, /remote\.versionId !== versionId/);
  assert.match(offsiteSync, /\.offsite-sync\.lock/);
  assert.match(offsiteSync, /client\?\.destroy\(\)/);
  assert.match(offsiteClient, /versionId: upload\.VersionId/);
  assert.match(offsiteClient, /NodeHttpHandler/);
  assert.doesNotMatch(`${offsiteSync}\n${offsiteClient}`, /DeleteObject|DeleteObjects/);
  assert.match(backupService, /^LoadCredential=backup-s3-access-key:/m);
  assert.match(backupService, /^LoadCredential=backup-s3-secret-key:/m);
  assert.match(backupService, /ExecStartPost=.*sync-production-backups\.mjs/);
  assert.doesNotMatch(backupService, /BACKUP_S3_ACCESS_KEY|BACKUP_S3_SECRET/);
});
