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
const rollback = readFileSync(resolve(root, 'ops/commerce/rollback-commerce.sh'), 'utf8');
const build = readFileSync(resolve(root, '_commerce/scripts/run-release-build.mjs'), 'utf8');
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

test('commerce deployment is immutable, atomic, secret-isolated, and automatically rolls back', () => {
  assert.match(deploy, /PAWSHOP_RELEASE_ACTIVATION_CONFIRMED/);
  assert.match(deploy, /source_dir=\/srv\/pawshop-source/);
  assert.match(deploy, /git_readonly archive/);
  assert.match(deploy, /runuser -u pawshop-build/);
  assert.match(deploy, /mv -Tf -- .*current_link/);
  assert.match(deploy, /trap rollback ERR INT TERM/);
  assert.match(deploy, /systemctl restart pawshop-commerce\.service/);
  assert.match(deploy, /chown -R root:root/);
  assert.match(deploy, /available_disk_kib < 8388608/);
  assert.match(deploy, /CRITICAL: activation failed and automatic restoration was not verified/);
  assert.doesNotMatch(deploy, /db:migrate|commerce\.env.*source|source .*commerce\.env/);
  assert.match(build, /media\.invalid/);
  assert.match(build, /validateProductionEnvironment/);
  assert.doesNotMatch(build, /commerce\.env|readFileSync/);
  assert.match(build, /HOME: '\/var\/cache\/pawshop-build'/);
});

test('manual rollback requires a retained exact release and schema compatibility gate', () => {
  assert.match(rollback, /PAWSHOP_ROLLBACK_COMPATIBLE/);
  assert.match(rollback, /\.pawshop-release/);
  assert.match(rollback, /mv -Tf -- .*current_link/);
  assert.match(rollback, /trap restore_previous ERR INT TERM/);
  assert.match(rollback, /CRITICAL: rollback failed and restoration was not verified/);
  assert.match(rollback, /! -user root -o -perm \/022/);
  assert.doesNotMatch(rollback, /rm -rf|db:migrate/);
});

test('owner admin exposes an explicit Simplified Chinese and English switch', () => {
  assert.match(languagePage, /i18n\.changeLanguage\(language\)/);
  assert.match(languagePage, /'zhCN' \| 'en'/);
  assert.match(languagePage, /简体中文/);
  assert.match(languagePage, /English/);
  assert.match(languagePage, /不会被自动翻译/);
});
