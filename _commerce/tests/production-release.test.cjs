'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  assertProductionEnvironmentFileStat, parseProductionEnvironmentFile, requiredFields,
} = require('../scripts/production-env-file.cjs');

const root = resolve(__dirname, '..', '..');
const deploy = readFileSync(resolve(root, 'ops/commerce/deploy-commerce.sh'), 'utf8');
const prepare = readFileSync(resolve(root, 'ops/commerce/prepare-commerce-release.sh'), 'utf8');
const rollback = readFileSync(resolve(root, 'ops/commerce/rollback-commerce.sh'), 'utf8');
const installer = readFileSync(resolve(root, 'ops/commerce/install-commerce-runtime.sh'), 'utf8');
const build = readFileSync(resolve(root, '_commerce/scripts/run-release-build.mjs'), 'utf8');
const evidenceVerifier = readFileSync(resolve(root, '_commerce/scripts/verify-release-evidence.mjs'), 'utf8');
const releaseManifest = readFileSync(resolve(root, '_commerce/scripts/release-manifest.cjs'), 'utf8');
const trackedVerifier = readFileSync(resolve(root, '_commerce/scripts/verify-tracked-release.mjs'), 'utf8');
const languagePage = readFileSync(resolve(root, '_commerce/src/admin/routes/language/page.tsx'), 'utf8');

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
  assert.doesNotMatch(deploy, /db:migrate|npm (ci|prune)|git_readonly archive|commerce\.env.*source|source .*commerce\.env/);
  assert.match(evidenceVerifier, /migration\.json/);
  assert.match(evidenceVerifier, /backup-restore\.json/);
  assert.match(evidenceVerifier, /migration_receipt_sha256/);
  assert.match(releaseManifest, /contentSha256/);
  assert.match(build, /media\.invalid/);
  assert.match(build, /validateProductionEnvironment/);
  assert.doesNotMatch(build, /commerce\.env|readFileSync/);
  assert.match(build, /HOME: '\/var\/cache\/pawshop-build'/);
  assert.match(build, /NODE_OPTIONS: '--max-old-space-size=1536'/);
  assert.match(build, /npmGlobalConfig = '\/etc\/pawshop-build\/npmrc-empty'/);
  assert.match(build, /npmGlobalConfigStat\.isSymbolicLink\(\)/);
  assert.match(build, /npmGlobalConfigStat\.uid !== 0/);
  assert.match(build, /npmGlobalConfigStat\.size !== 0/);
  assert.match(build, /npm_config_userconfig: '\/dev\/null'/);
  assert.match(build, /npm_config_globalconfig: npmGlobalConfig/);
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
