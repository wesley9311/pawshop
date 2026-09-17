'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync, symlinkSync, rmSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const {
  assertProductionEnvironmentFileStat, parseProductionEnvironmentFile, requiredFields,
} = require('../scripts/production-env-file.cjs');

const root = resolve(__dirname, '..', '..');
const deploy = readFileSync(resolve(root, 'ops/commerce/deploy-commerce.sh'), 'utf8');
const prepare = readFileSync(resolve(root, 'ops/commerce/prepare-commerce-release.sh'), 'utf8');
const rollback = readFileSync(resolve(root, 'ops/commerce/rollback-commerce.sh'), 'utf8');
const installer = readFileSync(resolve(root, 'ops/commerce/install-commerce-runtime.sh'), 'utf8');
const build = readFileSync(resolve(root, '_commerce/scripts/run-release-build.mjs'), 'utf8');
const seederPath = resolve(root, '_commerce/scripts/seed-module-migration-directories.mjs');
const evidenceVerifier = readFileSync(resolve(root, '_commerce/scripts/verify-release-evidence.mjs'), 'utf8');
const releaseManifest = readFileSync(resolve(root, '_commerce/scripts/release-manifest.cjs'), 'utf8');
const trackedVerifier = readFileSync(resolve(root, '_commerce/scripts/verify-tracked-release.mjs'), 'utf8');
const firstMigration = readFileSync(resolve(root, 'ops/commerce/run-first-production-migration.sh'), 'utf8');
const migrationRunner = readFileSync(resolve(root, '_commerce/scripts/run-first-production-migration.mjs'), 'utf8');
const productionRunner = readFileSync(resolve(root, '_commerce/scripts/run-production.mjs'), 'utf8');
const migrationWriter = readFileSync(resolve(root, '_commerce/scripts/write-production-migration-evidence.mjs'), 'utf8');
const backupEvidenceWriter = readFileSync(resolve(root, '_commerce/scripts/write-production-backup-restore-evidence.mjs'), 'utf8');
const firstBackupRestore = readFileSync(resolve(root, 'ops/commerce/run-first-production-backup-restore.sh'), 'utf8');
const backupPointerReader = readFileSync(resolve(root, '_commerce/scripts/read-production-backup-pointer.mjs'), 'utf8');
const offsiteSync = readFileSync(resolve(root, '_commerce/scripts/sync-production-backups.mjs'), 'utf8');
const firstBackupRunner = readFileSync(resolve(root, '_commerce/scripts/run-first-production-backup.mjs'), 'utf8');
const migrationGateWriter = readFileSync(resolve(root, '_commerce/scripts/write-production-migration-gate.mjs'), 'utf8');
const ownerProvisioner = readFileSync(resolve(root, '_commerce/scripts/provision-production-owner-credentials.mjs'), 'utf8');
const ownerCreator = readFileSync(resolve(root, '_commerce/scripts/create-production-owner.mjs'), 'utf8');
const ownerVerifier = readFileSync(resolve(root, '_commerce/scripts/verify-production-owner-login.mjs'), 'utf8');
const finalizer = readFileSync(resolve(root, 'ops/commerce/finalize-production-admin.sh'), 'utf8');
const languagePage = readFileSync(resolve(root, '_commerce/src/admin/routes/language/page.tsx'), 'utf8');
const { buildProductionEnvironment } = require('../scripts/production-environment-builder.cjs');
const medusaUserCommand = require('../node_modules/@medusajs/medusa/dist/commands/user.js').default;

function fixture() {
  return `${requiredFields.map(field => `${field}=${field === 'PAWSHOP_INFRA_TOPOLOGY' ? 'single-host-private' : 'fixture'}`).join('\n')}\n`;
}

test('production environment parser accepts only the exact non-shell contract', () => {
  const parsed = parseProductionEnvironmentFile(fixture());
  assert.deepEqual(Object.keys(parsed).sort(), requiredFields);
  assert.throws(() => parseProductionEnvironmentFile(`${fixture()}EXTRA=value\n`));
  assert.throws(() => parseProductionEnvironmentFile(`${fixture()}NODE_ENV=duplicate\n`));
  assert.throws(() => parseProductionEnvironmentFile(fixture().replace('NODE_ENV=fixture', 'NODE_ENV= fixture')));
  for (const special of ['\\', "'", '"', 'two words']) {
    assert.throws(() => parseProductionEnvironmentFile(fixture().replace('NODE_ENV=fixture', `NODE_ENV=${special}`)));
  }
  assert.throws(() => parseProductionEnvironmentFile(fixture().replace(
    'PAWSHOP_INFRA_TOPOLOGY=single-host-private', 'PAWSHOP_INFRA_TOPOLOGY=managed-tls',
  )));
});

test('production environment file ownership is exact', () => {
  const valid = { uid: 0, gid: 991, mode: 0o100640, isFile: () => true, isSymbolicLink: () => false };
  assert.doesNotThrow(() => assertProductionEnvironmentFileStat(valid, 991));
  for (const mutation of [
    { uid: 501 }, { gid: 20 }, { mode: 0o100644 },
    { isFile: () => false }, { isSymbolicLink: () => true },
  ]) assert.throws(() => assertProductionEnvironmentFileStat({ ...valid, ...mutation }, 991));
});

test('production environment builder fixes topology and keeps migrations disabled', () => {
  const source = buildProductionEnvironment({
    internalSource: [
      'DATABASE_URL=postgresql://pawshop:private@127.0.0.1:5432/pawshop?sslmode=disable',
      'REDIS_URL=redis://pawshop:private@127.0.0.1:6379',
      `JWT_SECRET=${'a'.repeat(64)}`,
      `COOKIE_SECRET=${'b'.repeat(64)}`,
      '',
    ].join('\n'),
    accessKeySource: 'fixture-access-key\n',
    secretKeySource: 'fixture-secret-value\n',
  });
  const parsed = parseProductionEnvironmentFile(source);
  assert.equal(parsed.PAWSHOP_MIGRATIONS_CONFIRMED, '0');
  assert.equal(parsed.PAWSHOP_MODE, 'production-admin-only');
  assert.equal(parsed.STOREFRONT_ORIGIN, 'https://pawlivora.com');
  assert.equal(parsed.ADMIN_ORIGIN, 'http://127.0.0.1:9000');
  assert.equal(parsed.S3_BUCKET, 'pawlivora-products-us-west-1');
  assert.equal(parsed.S3_DISABLE_ACL, '1');
  for (const bad of ['two lines\nsecret\n', ' leading', 'quote"value', 'short']) {
    assert.throws(() => buildProductionEnvironment({
      internalSource: bad === 'short' ? 'invalid' : [
        'DATABASE_URL=postgresql://pawshop:private@127.0.0.1:5432/pawshop?sslmode=disable',
        'REDIS_URL=redis://pawshop:private@127.0.0.1:6379',
        `JWT_SECRET=${'a'.repeat(64)}`,
        `COOKIE_SECRET=${'b'.repeat(64)}`,
      ].join('\n'),
      accessKeySource: 'fixture-access-key\n',
      secretKeySource: bad === 'short' ? 'fixture-secret-value\n' : bad,
    }));
  }
});

test('commerce activation consumes an immutable prepared release and verified evidence', () => {
  assert.match(deploy, /PAWSHOP_RELEASE_ACTIVATION_CONFIRMED/);
  assert.match(deploy, /verify-release-evidence\.mjs/);
  assert.match(deploy, /verify-release-manifest\.mjs/);
  assert.match(deploy, /verify-tracked-release\.mjs/);
  assert.match(deploy, /Installed runtime units do not match/);
  assert.match(deploy, /mv -Tf -- .*current_link/);
  assert.match(deploy, /trap rollback ERR INT TERM/);
  assert.match(deploy, /systemctl restart pawshop-commerce\.service/);
  assert.match(deploy, /CRITICAL: activation failed and automatic restoration was not verified/);
  assert.match(deploy, /write-production-migration-gate\.mjs/);
  assert.match(deploy, /rollback-disable/);
  assert.match(deploy, /gate_promoted/);
  assert.doesNotMatch(deploy, /db:migrate|npm (ci|prune)|git_readonly archive|commerce\.env.*source|source .*commerce\.env/);
  assert.match(evidenceVerifier, /migration\.json/);
  assert.match(evidenceVerifier, /backup-restore\.json/);
  assert.match(evidenceVerifier, /migration_receipt_sha256/);
  assert.match(releaseManifest, /contentSha256/);
  assert.match(build, /media\.invalid/);
  assert.match(build, /validateProductionEnvironment/);
  assert.doesNotMatch(build, /commerce\.env|readFileSync/);
  assert.match(build, /HOME: '\/var\/cache\/pawshop-build'/);
  // The heap cap must fit the host's RAM plus swap, and the build must yield to
  // production while it runs. 1536 MB on a 1.6 GB host thrashed the box hard
  // enough to take nginx and sshd offline, so the cap is asserted as a range
  // rather than as a number that would silently ratify an unsafe value.
  const heapCapMb = Number(/NODE_OPTIONS: '--max-old-space-size=(\d+)'/.exec(build)?.[1]);
  assert.ok(Number.isSafeInteger(heapCapMb), 'the release build must cap the Node heap explicitly');
  assert.ok(heapCapMb >= 512 && heapCapMb <= 1280, `unsafe release build heap cap: ${heapCapMb}`);
  assert.match(prepare, /ionice -c 3 nice -n 19/);
  assert.match(build, /npmGlobalConfig = '\/etc\/pawshop-build\/npmrc-empty'/);
  assert.match(build, /npmGlobalConfigStat\.isSymbolicLink\(\)/);
  assert.match(build, /npmGlobalConfigStat\.uid !== 0/);
  assert.match(build, /npmGlobalConfigStat\.size !== 0/);
  assert.match(build, /npm_config_userconfig: '\/dev\/null'/);
  assert.match(build, /npm_config_globalconfig: npmGlobalConfig/);
});

test('first activation changes the migration gate atomically and can fail closed', () => {
  assert.match(migrationGateWriter, /verify-release-evidence\.mjs/);
  assert.match(migrationGateWriter, /assertProductionEnvironmentFileStat/);
  assert.match(migrationGateWriter, /parseProductionEnvironmentFile/);
  assert.match(migrationGateWriter, /PAWSHOP_MIGRATIONS_CONFIRMED/);
  assert.match(migrationGateWriter, /O_EXCL \| constants\.O_NOFOLLOW/);
  assert.match(migrationGateWriter, /fsyncSync/);
  assert.match(migrationGateWriter, /renameSync/);
  assert.doesNotMatch(migrationGateWriter, /source .*commerce|\. .*commerce/);
});

test('first production migration is exact-release, empty-database, and fail-closed', () => {
  assert.match(firstMigration, /PAWSHOP_FIRST_MIGRATION_CONFIRMED/);
  assert.match(firstMigration, /production database is not empty/);
  assert.match(firstMigration, /runuser -u pawshop/);
  assert.match(firstMigration, /run-first-production-migration\.mjs/);
  assert.match(firstMigration, /write-production-migration-evidence\.mjs/);
  assert.match(firstMigration, /verify-release-manifest\.mjs/);
  assert.match(firstMigration, /verify-tracked-release\.mjs/);
  assert.match(firstMigration, /PAWSHOP_MIGRATIONS_CONFIRMED=0/);
  assert.doesNotMatch(firstMigration, /source .*commerce\.env|\. .*commerce\.env/);
  assert.match(migrationRunner, /parseProductionEnvironmentFile/);
  assert.match(migrationRunner, /process\.getuid\(\) === 0/);
  assert.match(migrationRunner, /\['db:migrate'\]/);
  assert.match(migrationWriter, /migration\.json/);
  assert.match(migrationWriter, /0o444/);
  assert.match(migrationWriter, /already exists and cannot be replaced/);
  assert.match(migrationWriter, /if \(lock !== undefined\)/);
  assert.match(migrationWriter, /assertMigrationEvidence/);
});

test('server commands run from the compiled release directory, not the source root', () => {
  // medusa-config is compiled JavaScript inside .medusa/server. The CLI resolves
  // the config relative to its working directory, so running it from the source
  // root failed with "Cannot find module medusa-config" and took the first
  // production migration down with it. Both facts are assertions now.
  assert.match(productionRunner, /\.medusa', 'server'/);
  assert.match(migrationRunner, /\.medusa', 'server'/);
  assert.match(productionRunner, /requireBuiltServerDirectory/);
  assert.match(migrationRunner, /lstatSync\(builtServer/);
  for (const guard of [
    /compiled production server directory is missing/,
    /compiled production server is missing/,
  ]) {
    assert.match(productionRunner, guard);
  }
  for (const guard of [
    /compiled production server directory is missing/,
    /compiled production configuration is missing/,
  ]) {
    assert.match(migrationRunner, guard);
  }
  // The build keeps compiling from the source root; only the server commands move.
  assert.match(productionRunner, /command === 'build' \? root : requireBuiltServerDirectory/);
  assert.match(productionRunner, /cwd: workingDirectory/);
  assert.match(migrationRunner, /cwd: builtServer/);
  // The deployment root keeps owning the safety scripts, so it must not be replaced.
  assert.doesNotMatch(productionRunner, /cwd: root|cwd: join\(root\)/);
});

test('backup evidence requires authenticated offsite and isolated restore records', () => {
  assert.match(backupEvidenceWriter, /offsiteReceiptIsValid/);
  assert.match(backupEvidenceWriter, /backupManifestHmac/);
  assert.match(backupEvidenceWriter, /assertRestoreVerification/);
  assert.match(backupEvidenceWriter, /assertBackupRestoreEvidence/);
  assert.match(backupEvidenceWriter, /Production backup target does not match the exact migrated commerce database/);
  assert.match(backupEvidenceWriter, /manifest\.value\.source_database !== migration\.value\.database/);
  assert.match(backupEvidenceWriter, /backup-restore\.json/);
  assert.match(backupEvidenceWriter, /already exists and cannot be replaced/);
  assert.doesNotMatch(backupEvidenceWriter, /S3_SECRET|secretAccessKey: process\.env/);
  assert.match(firstBackupRestore, /PAWSHOP_FIRST_BACKUP_RESTORE_CONFIRMED/);
  assert.match(firstBackupRestore, /systemd-run --quiet --wait --collect/);
  assert.match(firstBackupRestore, /LoadCredential=backup-s3-access-key/);
  assert.match(firstBackupRestore, /pawshop-restore-verify\.service/);
  assert.match(firstBackupRestore, /write-production-backup-restore-evidence\.mjs/);
  assert.match(firstBackupRestore, /verify-tracked-release\.mjs/);
  assert.match(firstBackupRestore, /for installed in restore-verify-production\.mjs backup-integrity\.cjs/);
  assert.match(firstBackupRestore, /cmp -s "\$release\/_commerce\/scripts\/\$installed"/);
  assert.match(firstBackupRestore, /trusted source must be the exact clean release commit/);
  assert.match(firstBackupRestore, /Commerce activation remains disabled/);
  assert.doesNotMatch(firstBackupRestore, /source .*backup|\. .*backup/);
  assert.match(backupPointerReader, /process\.getuid\(\) !== 0/);
  assert.match(backupPointerReader, /manifest_file/);
  assert.match(offsiteSync, /pawshop-first-backup-\[0-9a-f\]\{12\}/);
  assert.match(firstBackupRunner, /backup-production\.mjs/);
  assert.match(firstBackupRunner, /sync-production-backups\.mjs/);
  assert.match(firstBackupRunner, /exact immutable release/);
});

test('commerce release preparation builds an immutable candidate without activation', () => {
  assert.match(prepare, /PAWSHOP_RELEASE_ID/);
  assert.match(prepare, /git_readonly archive/);
  assert.match(prepare, /_commerce ops\/commerce/);
  assert.match(prepare, /runuser -u pawshop-build/);
  assert.match(prepare, /run-release-build\.mjs/);
  assert.match(prepare, /\.pawshop-release/);
  assert.match(prepare, /create-release-manifest\.mjs/);
  assert.match(prepare, /verify-release-manifest\.mjs/);
  assert.match(prepare, /source_dir\/_commerce\/scripts\/verify-tracked-release\.mjs/);
  assert.doesNotMatch(prepare, /node "\$staging_dir\/_commerce\/scripts\/(?:create|verify)-release/);
  assert.match(prepare, /unsafe_source_path=\$\(find "\$source_dir" \\\( ! -user root -o -perm \/022 \\\)/);
  assert.match(prepare, /unsafe_release_path=\$\(find "\$release_dir" \\\( ! -user root -o \\\( ! -type l -a -perm \/022 \\\) \\\)/);
  for (const releaseConsumer of [installer, deploy, rollback]) {
    assert.match(releaseConsumer, /! -user root -o \\\( ! -type l -a -perm \/022 \\\)/);
  }
  assert.match(prepare, /flock -n 9/);
  assert.match(prepare, /trap on_exit EXIT/);
  assert.match(prepare, /release_root_validated/);
  assert.match(prepare, /validate_root_directory \/srv\/pawshop-commerce/);
  assert.match(prepare, /validate_root_directory "\$release_root"/);
  assert.match(prepare, /validate_private_directory "\$build_path" "\$build_uid" "\$build_gid" 700/);
  assert.match(prepare, /validate_system_account pawshop-build \/var\/cache\/pawshop-build/);
  assert.match(prepare, /\$all_groups != "\$name"/);
  assert.match(prepare, /getent passwd \| awk/);
  assert.match(prepare, /cleanup \|\| status=1/);
  assert.match(prepare, /npm_config_userconfig=\/dev\/null/);
  assert.match(prepare, /empty_npmrc=\/etc\/pawshop-build\/npmrc-empty/);
  assert.match(prepare, /stat -c '%u:%g:%a:%s'.*empty_npmrc/);
  assert.match(prepare, /npm_config_globalconfig="\$empty_npmrc"/);
  assert.match(prepare, /temporary artifacts were removed/);
  assert.doesNotMatch(prepare, /systemctl|current_link|commerce\.env|db:migrate|PAWSHOP_RELEASE_ACTIVATION_CONFIRMED/);
  // The migration directories have to be seeded while the tree is still writable, and
  // before it is sealed: after `chown -R root:root` the migrator could not create them.
  assert.match(prepare, /seed-module-migration-directories\.mjs" "\$staging_dir"/);
  const seedAt = prepare.indexOf('seed-module-migration-directories.mjs');
  assert.ok(seedAt > prepare.indexOf('prune --omit=dev'), 'seeding must follow the final dependency install');
  assert.ok(seedAt < prepare.indexOf('chown -R root:root'), 'seeding must precede sealing the release');
});

test('release preparation seeds the module migration directories MikroORM needs', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pawshop-seed-'));
  const linkedTarget = mkdtempSync(join(tmpdir(), 'pawshop-seed-link-'));
  try {
    const modules = join(fixture, '_commerce', 'node_modules', '@medusajs');
    mkdirSync(join(modules, 'medusa', 'dist', 'migrations'), { recursive: true });
    writeFileSync(join(modules, 'medusa', 'dist', 'migrations', 'Migration20231228143900.js'), '');
    mkdirSync(join(modules, 'caching', 'dist'), { recursive: true });
    mkdirSync(join(modules, 'caching', 'migrations'), { recursive: true });
    mkdirSync(join(modules, 'file', 'dist'), { recursive: true });
    mkdirSync(join(modules, 'locking'), { recursive: true });
    writeFileSync(join(modules, 'stray.js'), '');
    symlinkSync(linkedTarget, join(modules, 'linked'));

    const run = spawnSync(process.execPath, [seederPath, fixture], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);

    // A built package that ships no migrations gets an empty compiled directory, which
    // is the path Medusa appends "migrations" to.
    assert.deepEqual(readdirSync(join(modules, 'file', 'dist', 'migrations')), []);
    // A package with no compiled directory gets one at its root instead.
    assert.deepEqual(readdirSync(join(modules, 'locking', 'migrations')), []);
    // A package that declares its own migrations keeps them, in either location, and is
    // never shadowed by an empty directory that would silently stop applying changes.
    assert.deepEqual(readdirSync(join(modules, 'medusa', 'dist', 'migrations')), ['Migration20231228143900.js']);
    assert.equal(existsSync(join(modules, 'medusa', 'migrations')), false);
    assert.equal(existsSync(join(modules, 'caching', 'dist', 'migrations')), false);
    // Symlinks are not followed and non-directories are ignored.
    assert.deepEqual(readdirSync(linkedTarget), []);
    assert.equal(existsSync(join(fixture, '_commerce', 'node_modules', '@medusajs', 'stray.js', 'migrations')), false);
    assert.match(run.stdout, /Seeded 2 empty module migration directories/);

    // Anything that is not a prepared release is refused rather than guessed at.
    for (const refused of [linkedTarget, join(fixture, 'missing'), 'relative/path']) {
      assert.notEqual(spawnSync(process.execPath, [seederPath, refused], { encoding: 'utf8' }).status, 0);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(linkedTarget, { recursive: true, force: true });
  }
});

test('reviewed runtime installation remains dormant and refuses existing files', () => {
  assert.match(installer, /\/srv\/pawshop-commerce\/releases\/\$PAWSHOP_RELEASE_ID/);
  assert.match(installer, /systemctl is-active --quiet/);
  assert.match(installer, /systemctl is-enabled/);
  assert.match(installer, /systemctl daemon-reload/);
  assert.match(installer, /flock -n 9/);
  assert.match(installer, /expected_enabled=static/);
  assert.match(installer, /source_dir\/_commerce\/scripts\/verify-release-manifest\.mjs/);
  assert.match(installer, /No commerce unit was started or enabled/);
  assert.doesNotMatch(installer, /systemctl (start|restart|enable)/);
  assert.match(trackedVerifier, /spawnSync\('\/usr\/bin\/git'/);
  assert.match(trackedVerifier, /'ls-tree'/);
  assert.match(trackedVerifier, /modified during build/);
});

test('manual rollback requires a retained exact release and schema compatibility gate', () => {
  assert.match(rollback, /PAWSHOP_ROLLBACK_COMPATIBLE/);
  assert.match(rollback, /\.pawshop-release/);
  assert.match(rollback, /mv -Tf -- .*current_link/);
  assert.match(rollback, /trap restore_previous ERR INT TERM/);
  assert.match(rollback, /CRITICAL: rollback failed and restoration was not verified/);
  assert.match(rollback, /! -user root -o \\\( ! -type l -a -perm \/022 \\\)/);
  assert.doesNotMatch(rollback, /rm -rf|db:migrate/);
});

test('owner admin exposes an explicit Simplified Chinese and English switch', () => {
  assert.match(languagePage, /i18n\.changeLanguage\(language\)/);
  assert.match(languagePage, /'zhCN' \| 'en'/);
  assert.match(languagePage, /简体中文/);
  assert.match(languagePage, /English/);
  assert.match(languagePage, /不会被自动翻译/);
});

test('production owner credentials stay out of argv and service-readable files', () => {
  assert.equal(typeof medusaUserCommand, 'function');
  assert.match(ownerProvisioner, /randomBytes\(24\)/);
  assert.match(ownerProvisioner, /O_EXCL \| constants\.O_NOFOLLOW/);
  assert.match(ownerProvisioner, /password was not printed/);
  assert.match(ownerCreator, /pawshop-production-owner-credentials\.json/);
  assert.match(ownerCreator, /process\.setgroups/);
  assert.match(ownerCreator, /process\.setgid/);
  assert.match(ownerCreator, /process\.setuid/);
  assert.match(ownerCreator, /password: credentials\.password/);
  assert.match(ownerCreator, /require\(commandPath\)\.default/);
  assert.match(ownerCreator, /provider_identity/);
  assert.match(ownerCreator, /auth_identity/);
  assert.match(ownerCreator, /partial or conflicting/);
  assert.doesNotMatch(ownerCreator, /'user'.*'-p'|execFileSync\([^\n]+password/);
  assert.match(ownerVerifier, /\/auth\/user\/emailpass/);
  assert.match(ownerVerifier, /\/admin\/users\/me/);
  assert.match(ownerVerifier, /\/admin\/products/);
  assert.match(ownerVerifier, /\/admin\/orders/);
  assert.match(ownerVerifier, /\/admin\/customers/);
  assert.doesNotMatch(ownerVerifier, /console\.log\([^\n]*(?:token|password|credentials)/);
  assert.match(finalizer, /PAWSHOP_PRODUCTION_ADMIN_FINALIZATION_CONFIRMED/);
  assert.match(finalizer, /create-production-owner\.mjs/);
  assert.match(finalizer, /verify-production-owner-login\.mjs/);
  assert.match(finalizer, /run-production-admin-verification\.mjs/);
  assert.match(finalizer, /timers=\(pawshop-backup\.timer pawshop-backup-monthly\.timer pawshop-backup-yearly\.timer\)/);
  assert.match(finalizer, /systemctl enable pawshop-commerce\.service "\$\{timers\[@\]\}"/);
  assert.match(finalizer, /pawshop-commerce-deploy\.lock/);
  assert.match(finalizer, /rollback_enablement/);
  assert.match(finalizer, /CRITICAL: production admin persistence finalization failed/);
  assert.match(finalizer, /systemctl is-enabled --quiet "\$timer" && restored=0/);
  assert.match(finalizer, /Public customer registration, checkout, and payment remain closed/);
});
