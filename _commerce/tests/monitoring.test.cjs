'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  EXIT_CODES, REQUIRED_SECURITY_HEADERS, adminRouteRequiresAuth, backupAgeHours, buildAlertPayload,
  checkResult, daysUntilExpiry, formatLogLine, missingSecurityHeaders, nextAlertState, redactUrl,
  shouldDispatchAlert, storeRouteIsClosed, summarize, validateMonitoringConfig,
} = require('../scripts/monitoring-policy.cjs');

const root = resolve(__dirname, '..');
const monitor = readFileSync(resolve(root, 'scripts/monitor-production.mjs'), 'utf8');
const monitorService = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-monitor.service'), 'utf8');
const monitorTimer = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-monitor.timer'), 'utf8');
const monitorEnvExample = readFileSync(resolve(root, '..', 'ops/commerce/monitoring.env.example'), 'utf8');

const env = {
  PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'https://pawlivora.com',
  PAWSHOP_MONITOR_COMMERCE_ORIGIN: 'http://127.0.0.1:9000',
};

test('monitoring configuration is fail-closed for origins and thresholds', () => {
  const config = validateMonitoringConfig(env);
  assert.equal(config.storefrontOrigin, 'https://pawlivora.com');
  assert.equal(config.commerceOrigin, 'http://127.0.0.1:9000');
  assert.equal(config.alertWebhook, null);
  assert.equal(config.databasePort, 5432);
  assert.equal(config.redisPort, 6379);
  assert.equal(config.minTlsDays, 14);

  for (const mutation of [
    { PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'http://pawlivora.com' },
    { PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'https://localhost' },
    { PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'https://127.0.0.1' },
    { PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'https://pawshop.example.invalid' },
    { PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'https://user:pass@pawlivora.com' },
    { PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'https://pawlivora.com/?debug=1' },
    { PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'https://pawlivora.com/admin' },
    { PAWSHOP_MONITOR_COMMERCE_ORIGIN: 'http://10.0.0.5:9000' },
    { PAWSHOP_MONITOR_COMMERCE_ORIGIN: 'https://127.0.0.1:9000' },
    { PAWSHOP_MONITOR_DATABASE_HOST: 'database.internal' },
    { PAWSHOP_MONITOR_MAX_BACKUP_AGE_HOURS: '0' },
    { PAWSHOP_MONITOR_MIN_TLS_DAYS: 'soon' },
    { PAWSHOP_MONITOR_ALERT_WEBHOOK: 'http://hooks.example.com/pawshop' },
    { PAWSHOP_MONITOR_ALERT_WEBHOOK: 'not-a-url' },
  ]) {
    assert.throws(() => validateMonitoringConfig({ ...env, ...mutation }), undefined, JSON.stringify(mutation));
  }
  assert.throws(() => validateMonitoringConfig({}));
});

test('alert webhook keeps its per-channel path and is never rewritten', () => {
  const config = validateMonitoringConfig({ ...env, PAWSHOP_MONITOR_ALERT_WEBHOOK: 'https://hooks.example.com/services/T000/B000/tokenvalue' });
  assert.equal(config.alertWebhook, 'https://hooks.example.com/services/T000/B000/tokenvalue');
});

test('logged urls are redacted and log levels are constrained', () => {
  assert.equal(redactUrl('https://user:secret@example.com/path?token=abc#frag'), 'https://example.com/path');
  assert.equal(redactUrl('not a url'), '<unparseable-url>');
  assert.match(formatLogLine('warn', 'disk low', new Date('2026-09-16T00:00:00Z')), /^2026-09-16T00:00:00\.000Z WARN disk low$/);
  assert.throws(() => formatLogLine('trace', 'nope', new Date()));
});

test('security header and certificate thresholds are enforced', () => {
  assert.deepEqual(missingSecurityHeaders(REQUIRED_SECURITY_HEADERS), []);
  assert.deepEqual(missingSecurityHeaders(['Strict-Transport-Security', 'X-Content-Type-Options']), []);
  assert.deepEqual(missingSecurityHeaders(['strict-transport-security']), ['x-content-type-options']);
  const now = new Date('2026-09-16T00:00:00Z');
  assert.equal(daysUntilExpiry('2026-10-16T00:00:00Z', now), 30);
  assert.throws(() => daysUntilExpiry('not-a-date', now));
  assert.equal(Number(backupAgeHours('2026-09-15T12:00:00Z', now).toFixed(1)), 12);
  assert.throws(() => backupAgeHours('not-a-date', now));
});

test('closed store routes and authenticated admin routes are the monitored invariants', () => {
  for (const status of [400, 401, 403, 404, 503]) assert.equal(storeRouteIsClosed(status), true);
  for (const status of [200, 201, 204, 0, undefined]) assert.equal(storeRouteIsClosed(status), false);
  assert.equal(adminRouteRequiresAuth(401), true);
  assert.equal(adminRouteRequiresAuth(403), true);
  assert.equal(adminRouteRequiresAuth(200), false);
});

test('alerting suppresses repeats, reports recovery, and carries no secret material', () => {
  const now = new Date('2026-09-16T00:00:00Z');
  const failing = summarize([
    checkResult('commerce_health', false, 'commerce health returned 503'),
    checkResult('disk_space', true),
  ]);
  assert.equal(failing.failed, 1);
  assert.deepEqual(failing.failing, ['commerce_health']);
  assert.throws(() => checkResult('', true));
  assert.throws(() => summarize([]));

  assert.equal(shouldDispatchAlert(null, failing, now, 30), true);
  assert.equal(shouldDispatchAlert({ status: 'healthy' }, failing, now, 30), true);
  // A stale alert window is allowed through; a recent identical alert is suppressed.
  const staleFailing = { status: 'failing', signature: 'commerce_health', last_alert_at: '2026-09-15T23:00:00.000Z' };
  const recentFailing = { status: 'failing', signature: 'commerce_health', last_alert_at: '2026-09-15T23:50:00.000Z' };
  assert.equal(shouldDispatchAlert(staleFailing, failing, now, 30), true);
  assert.equal(shouldDispatchAlert(recentFailing, failing, now, 30), false);
  // A changed failure signature always escalates immediately.
  assert.equal(shouldDispatchAlert({ ...recentFailing, signature: 'disk_space' }, failing, now, 30), true);

  const recovered = summarize([checkResult('commerce_health', true)]);
  assert.equal(shouldDispatchAlert(recentFailing, recovered, now, 30), true);
  assert.equal(shouldDispatchAlert(null, recovered, now, 30), false);

  const payload = buildAlertPayload(failing, now, 'https://pawlivora.com');
  assert.equal(payload.schema, 'pawshop-monitor-alert-v1');
  assert.equal(payload.status, 'failing');
  assert.deepEqual(Object.keys(payload).sort(), ['at', 'checked', 'details', 'failed', 'failing', 'passed', 'schema', 'status', 'storefront']);
  assert.doesNotMatch(JSON.stringify(payload), /secret|password|token|authorization|cookie|key/i);
  assert.equal(nextAlertState(null, recovered, now, false).status, 'healthy');
  assert.equal(nextAlertState(null, failing, now, true).last_alert_at, now.toISOString());
  assert.equal(nextAlertState(recentFailing, failing, now, false).last_alert_at, recentFailing.last_alert_at);
  // Exit codes are a tested contract: 0 healthy, 1 checks failed, 2 alerting broken.
  assert.deepEqual(EXIT_CODES, { healthy: 0, checksFailed: 1, alertDeliveryFailed: 2 });
});

test('monitor runner bounds every call and never logs secret material', () => {
  assert.match(monitor, /validateMonitoringConfig/);
  assert.match(monitor, /AbortSignal\.timeout\(config\.timeoutMs\)/);
  assert.match(monitor, /socket\.setTimeout\(config\.timeoutMs\)/);
  assert.match(monitor, /timeout: config\.timeoutMs/);
  assert.doesNotMatch(monitor, /console\.log\(\s*(process\.env|config\.alertWebhook)/);
  assert.doesNotMatch(monitor, /JSON\.stringify\(process\.env\)/);
  assert.doesNotMatch(monitor, /authorization|cookie/i);
  assert.match(monitor, /alert webhook is not configured; alert recorded locally only/);
  assert.match(monitor, /process\.exit\(EXIT_CODES\.healthy\)/);
  assert.match(monitor, /EXIT_CODES\.alertDeliveryFailed/);
  assert.match(monitor, /EXIT_CODES\.checksFailed/);
  // The closed-route invariant and the backup freshness gate must be real checks.
  assert.match(monitor, /store_api_closed/);
  assert.match(monitor, /admin_requires_auth/);
  assert.match(monitor, /backup_freshness/);
  assert.match(monitor, /pawshop-backup\.service/);
  assert.match(monitor, /disk_space/);
  assert.match(monitor, /tls_certificate/);
  // Availability and security headers are separate checks so an outage is never
  // confused with a header regression.
  assert.match(monitor, /storefront_security_headers/);
  assert.match(monitor, /storefront_latency/);
  assert.match(monitor, /redis_connectivity/);
});

test('monitor units are hardened, non-privileged, and read a non-secret config', () => {
  assert.match(monitorService, /^User=pawshop$/m);
  assert.match(monitorService, /^Type=oneshot$/m);
  assert.match(monitorService, /NoNewPrivileges=true/);
  assert.match(monitorService, /ProtectSystem=strict/);
  assert.match(monitorService, /ProtectHome=true/);
  assert.match(monitorService, /CapabilityBoundingSet=$/m);
  assert.match(monitorService, /PrivateTmp=true/);
  assert.match(monitorService, /EnvironmentFile=\/etc\/pawshop-monitor\/monitoring\.env/);
  assert.match(monitorService, /ExecStart=\/usr\/bin\/node scripts\/monitor-production\.mjs/);
  assert.doesNotMatch(monitorService, /LoadCredential/);
  assert.match(monitorTimer, /^OnCalendar=\*:0\/5$/m);
  assert.match(monitorTimer, /^Persistent=true$/m);
  assert.match(monitorEnvExample, /PAWSHOP_MONITOR_STOREFRONT_ORIGIN=https:\/\//);
  assert.doesNotMatch(monitorEnvExample, /replace-me.*=.*replace-me/);
  for (const line of monitorEnvExample.split('\n').filter(line => line && !line.startsWith('#'))) {
    assert.doesNotMatch(line, /(SECRET|PASSWORD|ACCESS_KEY|TOKEN)=/i, `secret-looking key in example: ${line}`);
  }
});
