'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  ALERT_ENVELOPE, ALERT_PROVIDERS, ALERT_TEXT_MAX_CHARS, EXIT_CODES, REQUIRED_SECURITY_HEADERS,
  adminRouteRequiresAuth, alertDeliveryAccepted, alertProviderErrorCode, backupAgeHours,
  backupFreshnessCheck, buildAlertPayload,
  buildAlertRequest,
  checkResult, daysUntilExpiry, describeAlertProviderCode, feishuAccepted, formatAlertText, formatLogLine,
  missingSecurityHeaders,
  nextAlertState, recordedTimestampToIso, redactUrl, shouldDispatchAlert, storeApiIsOpen, summarize, systemdTimestampToIso,
  telegramAccepted,
  validateMonitoringConfig,
} = require('../scripts/monitoring-policy.cjs');

const root = resolve(__dirname, '..');
const monitor = readFileSync(resolve(root, 'scripts/monitor-production.mjs'), 'utf8');
const monitoringPolicy = readFileSync(resolve(root, 'scripts/monitoring-policy.cjs'), 'utf8');
const monitorService = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-monitor.service'), 'utf8');
const monitorTimer = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-monitor.timer'), 'utf8');
const monitorEnvExample = readFileSync(resolve(root, '..', 'ops/commerce/monitoring.env.example'), 'utf8');
const scheduledBackup = readFileSync(resolve(root, 'scripts/run-scheduled-backup.mjs'), 'utf8');
const backupService = readFileSync(resolve(root, '..', 'ops/commerce/pawshop-backup.service'), 'utf8');

const env = {
  PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'https://pawlivora.com',
  PAWSHOP_MONITOR_COMMERCE_ORIGIN: 'http://127.0.0.1:9000',
};

test('monitoring configuration is fail-closed for origins and thresholds', () => {
  const config = validateMonitoringConfig(env);
  assert.equal(config.storefrontOrigin, 'https://pawlivora.com');
  assert.equal(config.commerceOrigin, 'http://127.0.0.1:9000');
  assert.equal(config.storefrontPublishableKey, null);
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
    // A key that is not a key: the probe would then answer 400 forever and report
    // a shut shop on a host whose shop is open. The api-key id is the mistake that
    // is actually easy to make - Medusa shows the id and the token side by side,
    // and the store API accepts only the token.
    { PAWSHOP_MONITOR_STOREFRONT_PUBLISHABLE_KEY: 'apk_01M2Q71GAW3WBB16CMD7CBTC6F' },
    { PAWSHOP_MONITOR_STOREFRONT_PUBLISHABLE_KEY: 'monitor-probe' },
    { PAWSHOP_MONITOR_STOREFRONT_PUBLISHABLE_KEY: 'pk_short' },
    { PAWSHOP_MONITOR_STOREFRONT_PUBLISHABLE_KEY: `pk_${'a'.repeat(64)} ` },
  ]) {
    assert.throws(() => validateMonitoringConfig({ ...env, ...mutation }), undefined, JSON.stringify(mutation));
  }
  assert.throws(() => validateMonitoringConfig({}));

  const token = `pk_${'a'.repeat(64)}`;
  assert.equal(validateMonitoringConfig({ ...env, PAWSHOP_MONITOR_STOREFRONT_PUBLISHABLE_KEY: token }).storefrontPublishableKey, token);
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

test('an open storefront and an authenticated admin route are the monitored invariants', () => {
  // The shop is open, so "closed" is no longer an invariant worth asserting: the
  // publishable-key gate answers 400 to a stranger's key in both profiles, which
  // is why the old probe passed whether the shop was open or shut. Only a 200
  // carrying a product list proves the route is really serving.
  assert.equal(storeApiIsOpen(200, { products: [] }), true);
  assert.equal(storeApiIsOpen(200, { products: [{ id: 'prod_1' }], count: 1 }), true);
  assert.equal(storeApiIsOpen(200, {}), false);
  assert.equal(storeApiIsOpen(200, { products: null }), false);
  assert.equal(storeApiIsOpen(200, null), false);
  assert.equal(storeApiIsOpen(200, 'products'), false);
  for (const status of [400, 401, 403, 404, 503, 0, undefined, '200']) {
    assert.equal(storeApiIsOpen(status, { products: [] }), false);
  }
  assert.equal(adminRouteRequiresAuth(401), true);
  assert.equal(adminRouteRequiresAuth(403), true);
  assert.equal(adminRouteRequiresAuth(200), false);
});

test('the storefront probe sends the configured publishable key, never a stand-in', () => {
  // Regression: the probe used to send the literal "monitor-probe". Medusa answers
  // 400 to any key it does not know, and the old assertion only asked for a
  // non-2xx, so the check passed for the wrong reason in both profiles and could
  // not have noticed the shop opening or closing. The probe must send exactly what
  // the environment declares, and the verdict must read the status and the body.
  assert.match(monitor, /'x-publishable-api-key': config\.storefrontPublishableKey/);
  assert.doesNotMatch(monitor, /monitor-probe/);
  assert.match(monitor, /storeApiIsOpen\(response\.status, response\.json\)/);
  assert.match(monitor, /PAWSHOP_MONITOR_STOREFRONT_PUBLISHABLE_KEY is not configured/);
  assert.match(monitorEnvExample, /^PAWSHOP_MONITOR_STOREFRONT_PUBLISHABLE_KEY=/m);
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

test('alert payloads are translated into each channel dialect', () => {
  const now = new Date('2026-09-16T09:00:00Z');
  const summary = summarize([
    checkResult('commerce_health', false, 'commerce health returned 503'),
    checkResult('store_api_open', true),
  ]);
  const payload = buildAlertPayload(summary, now, 'https://pawlivora.com');

  // generic keeps the machine payload so an internal endpoint loses nothing.
  const generic = JSON.parse(buildAlertRequest({ alertProvider: 'generic' }, payload).body);
  assert.equal(generic.schema, 'pawshop-monitor-alert-v1');
  assert.deepEqual(buildAlertRequest({ alertProvider: 'generic' }, payload).headers['content-type'], 'application/json');

  // Slack rejects anything without a top-level text field.
  const slack = JSON.parse(buildAlertRequest({ alertProvider: 'slack' }, payload).body);
  assert.deepEqual(Object.keys(slack), ['text']);

  // Feishu requires msg_type + content.text; Telegram requires chat_id + text.
  const feishu = JSON.parse(buildAlertRequest({ alertProvider: 'feishu' }, payload).body);
  assert.equal(feishu.msg_type, 'text');
  assert.equal(typeof feishu.content.text, 'string');
  const telegram = JSON.parse(buildAlertRequest({ alertProvider: 'telegram', telegramChatId: '12345' }, payload).body);
  assert.equal(telegram.chat_id, '12345');
  assert.equal(telegram.disable_web_page_preview, true);
  assert.throws(() => buildAlertRequest({ alertProvider: 'telegram' }, payload));

  // The readable text keeps the machine check names and stays bounded.
  const text = formatAlertText(payload);
  assert.match(text, /\[PawShop\] 告警 1\/2 项检查失败/);
  assert.match(text, /commerce_health/);
  assert.match(text, /https:\/\/pawlivora\.com/);
  assert.ok(text.length <= ALERT_TEXT_MAX_CHARS);
  const recovered = formatAlertText(buildAlertPayload(summarize([checkResult('disk_space', true)]), now, 'https://pawlivora.com'));
  // A recovery must survive any deliverability filter an alert survives: both open
  // with the same envelope, so a keyword drawn from it matches both. Phrasing them
  // differently drops exactly the all-clear message (measured: Feishu answered
  // 19024 "Key Words Not Found" for a differently-phrased recovery while accepting
  // the alert).
  assert.ok(recovered.startsWith(ALERT_ENVELOPE), `recovery must open with the envelope: ${recovered.split('\n')[0]}`);
  assert.ok(text.startsWith(ALERT_ENVELOPE));
  // The keyword belongs to the chat group and drifted once already, silently
  // costing every alert. The envelope carries both spellings the live channel has
  // required, so either keyword keeps both messages deliverable.
  assert.equal(ALERT_ENVELOPE, '[PawShop] 告警');
  for (const message of [text, recovered]) {
    // Any keyword drawn from the envelope must match both messages, so the
    // spellings the live channel has required all have to be present.
    for (const keyword of ['PawShop', '[PawShop]', '告警']) {
      assert.ok(message.includes(keyword), `every message must satisfy the "${keyword}" keyword: ${message.split('\n')[0]}`);
    }
  }
  assert.match(recovered, /已恢复/);
  assert.doesNotMatch(recovered, /项检查失败/);
  assert.doesNotMatch(text, /secret|password|token|authorization|cookie/i);
  assert.throws(() => formatAlertText(null));
  assert.throws(() => buildAlertRequest(null, payload));
});

test('each channel webhook is pinned to its vendor host', () => {
  assert.deepEqual([...ALERT_PROVIDERS], ['generic', 'slack', 'feishu', 'telegram']);
  const base = {
    PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'https://pawlivora.com',
    PAWSHOP_MONITOR_COMMERCE_ORIGIN: 'http://127.0.0.1:9000',
  };
  const slack = validateMonitoringConfig({ ...base, PAWSHOP_MONITOR_ALERT_PROVIDER: 'slack', PAWSHOP_MONITOR_ALERT_WEBHOOK: 'https://hooks.slack.com/services/T/B/X' });
  assert.equal(slack.alertProvider, 'slack');
  const feishu = validateMonitoringConfig({ ...base, PAWSHOP_MONITOR_ALERT_PROVIDER: 'feishu', PAWSHOP_MONITOR_ALERT_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' });
  assert.equal(feishu.alertProvider, 'feishu');
  const telegram = validateMonitoringConfig({
    ...base,
    PAWSHOP_MONITOR_ALERT_PROVIDER: 'telegram',
    PAWSHOP_MONITOR_ALERT_WEBHOOK: 'https://api.telegram.org/bot123:abc/sendMessage',
    PAWSHOP_MONITOR_TELEGRAM_CHAT_ID: '  -100123  ',
  });
  assert.equal(telegram.telegramChatId, '-100123');

  for (const mutation of [
    { PAWSHOP_MONITOR_ALERT_PROVIDER: 'email' },
    { PAWSHOP_MONITOR_ALERT_PROVIDER: 'slack' },
    { PAWSHOP_MONITOR_ALERT_PROVIDER: 'slack', PAWSHOP_MONITOR_ALERT_WEBHOOK: 'https://evil.example.com/services/T/B/X' },
    { PAWSHOP_MONITOR_ALERT_PROVIDER: 'feishu', PAWSHOP_MONITOR_ALERT_WEBHOOK: 'https://evil.example.com/open-apis/bot/v2/hook/abc' },
    { PAWSHOP_MONITOR_ALERT_PROVIDER: 'telegram', PAWSHOP_MONITOR_ALERT_WEBHOOK: 'https://evil.example.com/bot123/sendMessage', PAWSHOP_MONITOR_TELEGRAM_CHAT_ID: '1' },
    { PAWSHOP_MONITOR_ALERT_PROVIDER: 'telegram', PAWSHOP_MONITOR_ALERT_WEBHOOK: 'https://api.telegram.org/bot123:abc/sendMessage' },
  ]) {
    assert.throws(() => validateMonitoringConfig({ ...base, ...mutation }), undefined, JSON.stringify(mutation));
  }
  // A declared channel without an endpoint must fail closed, not monitor silently.
  assert.throws(() => validateMonitoringConfig({ ...base, PAWSHOP_MONITOR_ALERT_PROVIDER: 'feishu' }));
});

test('a chat channel that answers 200 with an error code counts as a failed delivery', () => {
  // The exact trap: Feishu and Telegram report application errors inside a 200.
  assert.equal(alertDeliveryAccepted('feishu', 200, '{"code":0,"msg":"success"}'), true);
  assert.equal(alertDeliveryAccepted('feishu', 200, '{"StatusCode":0,"StatusMessage":"success"}'), true);
  assert.equal(alertDeliveryAccepted('feishu', 200, '{"code":9499,"msg":"param invalid"}'), false);
  assert.equal(alertDeliveryAccepted('feishu', 200, '<html>gateway</html>'), false);
  assert.equal(alertDeliveryAccepted('telegram', 200, '{"ok":true}'), true);
  assert.equal(alertDeliveryAccepted('telegram', 200, '{"ok":false,"description":"chat not found"}'), false);
  assert.equal(alertDeliveryAccepted('telegram', 200, '{"ok":false}'), false);
  assert.equal(alertDeliveryAccepted('slack', 200, 'ok'), true);
  assert.equal(alertDeliveryAccepted('slack', 400, 'invalid_payload'), false);
  assert.equal(alertDeliveryAccepted('generic', 202, ''), true);
  assert.equal(alertDeliveryAccepted('generic', 500, 'boom'), false);
  assert.equal(alertDeliveryAccepted('generic', 0, ''), false);
  assert.equal(feishuAccepted('{"code":0}'), true);
  assert.equal(telegramAccepted('{"ok":true}'), true);
  assert.equal(telegramAccepted('not json'), false);

  // The runner must build and accept the payload per channel, so a second
  // channel never inherits the first one's dialect.
  assert.match(monitor, /buildAlertRequest\(\{ provider: channel\.provider, telegramChatId: config\.telegramChatId \}, payload\)/);
  assert.match(monitor, /alertDeliveryAccepted\(channel\.provider, response\.status, bodyText\)/);
  assert.doesNotMatch(monitor, /alertDeliveryAccepted\(config\.alertProvider/);
  assert.doesNotMatch(monitor, /alert webhook rejected the payload with status/);
  assert.match(monitor, /for \(const channel of config\.alertChannels\)/);
  // An alert deliberately held back by the repeat window is not a broken channel:
  // only an attempted delivery may report the alerting path as failed.
  assert.match(monitor, /const alertDeliveryFailed = dispatchResult\.attempted && !dispatchResult\.dispatched/);
  assert.doesNotMatch(monitor, /const alertDeliveryFailed = dispatchResult\.configured/);
  assert.match(monitor, /attempted: true, \.\.\.\(await dispatchAlert\(buildAlertPayload/);
  // A healthy run reaches the same else branch (shouldDispatchAlert returns
  // false when nothing failed and no recovery is owed), so the suppression line
  // must be gated on an actual failure. Otherwise a green run logs "the failure
  // is still recorded" and invents an outage nobody can find.
  assert.match(monitor, /else if \(config\.alertChannels\.length > 0 && summary\.failed > 0\)/);
});

test('a rejected channel names the provider error code and never the response body', () => {
  // Regression: a live Feishu channel answered 200 with {"code":19024} and the
  // journal only said "did not accept the payload", so diagnosing it required
  // writing an ad-hoc probe script against the production webhook.
  assert.equal(alertProviderErrorCode('{"code":19024,"data":{},"msg":"Key Words Not Found"}'), 19024);
  assert.equal(alertProviderErrorCode('{"StatusCode":0,"StatusMessage":"success"}'), 0);
  assert.equal(alertProviderErrorCode('{"error_code":"19021"}'), 19021);
  assert.equal(alertProviderErrorCode('ok'), null);
  assert.equal(alertProviderErrorCode(''), null);
  assert.equal(alertProviderErrorCode('<html>gateway</html>'), null);
  assert.equal(alertProviderErrorCode('{"code":null}'), null);
  assert.equal(alertProviderErrorCode('{"code":"not-a-number"}'), null);

  assert.match(describeAlertProviderCode(19024), /keyword/);
  assert.match(describeAlertProviderCode(19021), /signature/);
  // An unknown code is still reported; only the invented explanation is withheld.
  assert.equal(describeAlertProviderCode(4242), '');
  assert.equal(describeAlertProviderCode(null), '');
  assert.equal(describeAlertProviderCode('19024'), '');

  assert.match(monitor, /alertProviderErrorCode\(bodyText\)/);
  assert.match(monitor, /describeAlertProviderCode\(providerCode\)/);
  // The body itself must stay out of the journal: only the numeric code is logged.
  assert.doesNotMatch(monitor, /did not accept the payload[^`]*\$\{bodyText\}/);
  assert.doesNotMatch(monitor, /log\([^)]*bodyText\)/);
});

test('alerting fans out over every configured channel and needs one acknowledgement', () => {
  const base = {
    PAWSHOP_MONITOR_STOREFRONT_ORIGIN: 'https://pawlivora.com',
    PAWSHOP_MONITOR_COMMERCE_ORIGIN: 'http://127.0.0.1:9000',
  };
  const both = validateMonitoringConfig({
    ...base,
    PAWSHOP_MONITOR_ALERT_CHANNELS:
      'feishu:https://open.feishu.cn/open-apis/bot/v2/hook/aaa, slack:https://hooks.slack.com/services/T/B/xxx',
  });
  assert.deepEqual(both.alertChannels.map((channel) => [channel.label, channel.provider]), [
    ['feishu', 'feishu'],
    ['slack', 'slack'],
  ]);
  // Two channels are not describable by the single-webhook field, so the legacy
  // view must not silently report only one of them.
  assert.equal(both.alertWebhook, null);
  assert.equal(both.alertProvider, 'generic');

  // A single channel still populates the legacy view, so nothing regresses for
  // the one-channel configuration.
  const single = validateMonitoringConfig({
    ...base,
    PAWSHOP_MONITOR_ALERT_CHANNELS: 'feishu:https://open.feishu.cn/open-apis/bot/v2/hook/aaa',
  });
  assert.equal(single.alertChannels.length, 1);
  assert.equal(single.alertWebhook, 'https://open.feishu.cn/open-apis/bot/v2/hook/aaa');
  assert.equal(single.alertProvider, 'feishu');

  // Two groups on the same platform must stay distinguishable in the journal.
  const duplicate = validateMonitoringConfig({
    ...base,
    PAWSHOP_MONITOR_ALERT_CHANNELS:
      'feishu:https://open.feishu.cn/open-apis/bot/v2/hook/a,feishu:https://open.feishu.cn/open-apis/bot/v2/hook/b',
  });
  assert.deepEqual(duplicate.alertChannels.map((channel) => channel.label), ['feishu', 'feishu#2']);

  // A second channel is only a safety net if it is declared and pinned correctly.
  for (const mutation of [
    { PAWSHOP_MONITOR_ALERT_CHANNELS: 'feishu:https://evil.example.com/open-apis/bot/v2/hook/a' },
    { PAWSHOP_MONITOR_ALERT_CHANNELS: 'hooks.slack.com/services/T/B/x' },
    { PAWSHOP_MONITOR_ALERT_CHANNELS: 'email:https://mail.example.com/x' },
    { PAWSHOP_MONITOR_ALERT_CHANNELS: 'feishu:http://open.feishu.cn/open-apis/bot/v2/hook/a' },
    { PAWSHOP_MONITOR_ALERT_CHANNELS: 'telegram:https://api.telegram.org/bot1:a/sendMessage' },
    // Two competing declarations is an operator error, not something to merge.
    {
      PAWSHOP_MONITOR_ALERT_CHANNELS: 'slack:https://hooks.slack.com/services/T/B/x',
      PAWSHOP_MONITOR_ALERT_WEBHOOK: 'https://hooks.slack.com/services/T/B/y',
    },
  ]) {
    assert.throws(() => validateMonitoringConfig({ ...base, ...mutation }), undefined, JSON.stringify(mutation));
  }

  // Nothing configured is log-only, not a startup failure.
  assert.deepEqual(validateMonitoringConfig(base).alertChannels, []);
});

test('monitor runner bounds every call and never logs secret material', () => {
  assert.match(monitor, /validateMonitoringConfig/);
  assert.match(monitor, /AbortSignal\.timeout\(config\.timeoutMs\)/);
  assert.match(monitor, /socket\.setTimeout\(config\.timeoutMs\)/);
  assert.match(monitor, /timeout: config\.timeoutMs/);
  assert.doesNotMatch(monitor, /console\.log\(\s*(process\.env|config\.alertWebhook)/);
  assert.doesNotMatch(monitor, /JSON\.stringify\(process\.env\)/);
  assert.doesNotMatch(monitor, /authorization|cookie/i);
  assert.match(monitor, /no alert channel is configured; alert recorded locally only/);
  assert.match(monitor, /process\.exit\(EXIT_CODES\.healthy\)/);
  assert.match(monitor, /EXIT_CODES\.alertDeliveryFailed/);
  assert.match(monitor, /EXIT_CODES\.checksFailed/);
  // The storefront-open invariant and the backup freshness gate must be real checks.
  assert.match(monitor, /store_api_open/);
  assert.match(monitor, /admin_requires_auth/);
  assert.match(monitor, /backupFreshnessCheck/);
  // The freshness check name is emitted where the verdict is computed, which is
  // the shared policy module, so that is where the name has to exist.
  assert.match(monitoringPolicy, /checkResult\('backup_freshness'/);
  assert.match(monitor, /pawshop-backup\.service/);
  assert.match(monitor, /disk_space/);
  assert.match(monitor, /tls_certificate/);
  // Availability and security headers are separate checks so an outage is never
  // confused with a header regression.
  assert.match(monitor, /storefront_security_headers/);
  assert.match(monitor, /storefront_latency/);
  assert.match(monitor, /redis_connectivity/);
});

test('commerce checks are skippable only by explicit configuration', () => {
  // The flag must be an exact literal comparison, not a truthy check.
  assert.match(monitor, /process\.env\.PAWSHOP_MONITOR_SKIP_COMMERCE_CHECKS === '1'/);
  assert.match(monitor, /commerce checks skipped by explicit configuration/);
  // A skip must be announced on every run so it is never mistaken for a verified
  // commerce path.
  assert.match(monitor, /log\('WARN', 'commerce checks are skipped by explicit configuration/);
  // The real checks must still exist for when the skip is removed.
  assert.match(monitor, /commerce health unreachable/);
  assert.match(monitor, /store route probe failed/);
  assert.match(monitor, /admin auth probe failed/);
});

test('backup freshness survives an unrecorded run and reads systemd timestamps in local time', () => {
  // systemd prints local wall-clock time with a timezone abbreviation. The
  // verdict must read those fields as local time: handing the whole string to
  // Date lets the engine resolve "CST" as US Central, which moved every age
  // fourteen hours towards "fresh" and let a stale backup pass a 36h limit.
  const systemdValue = 'Thu 2026-09-17 14:18:07 CST';
  const lastRunInstant = new Date(2026, 8, 17, 14, 18, 7).getTime();
  const hoursAfter = hours => new Date(lastRunInstant + hours * 3600000);

  assert.equal(systemdTimestampToIso(systemdValue), new Date(lastRunInstant).toISOString());
  assert.equal(systemdTimestampToIso(undefined), null);
  assert.equal(systemdTimestampToIso(''), null);
  assert.equal(systemdTimestampToIso('   '), null);
  // A field the Date constructor would silently normalise is not a real instant.
  assert.equal(systemdTimestampToIso('Thu 2026-13-40 25:61:61 CST'), null);
  assert.equal(systemdTimestampToIso('Thu 2026-09-17 14:18:07'), new Date(lastRunInstant).toISOString());

  const fresh = backupFreshnessCheck({ result: 'success', lastRun: systemdValue }, hoursAfter(3), 36);
  assert.equal(fresh.name, 'backup_freshness');
  assert.equal(fresh.ok, true);
  assert.match(fresh.detail, /3\.0h ago/);

  const stale = backupFreshnessCheck({ result: 'success', lastRun: systemdValue }, hoursAfter(41), 36);
  assert.equal(stale.ok, false);

  // The regression that took the whole run down: a unit that has not run since
  // the host booted reports Result=success with an empty completion timestamp.
  const neverRan = backupFreshnessCheck({ result: 'success', lastRun: '' }, hoursAfter(1), 36);
  assert.equal(neverRan.ok, false);
  assert.match(neverRan.detail, /no completed run recorded since the host booted/);

  assert.match(
    backupFreshnessCheck({ result: 'exit-code', lastRun: systemdValue }, hoursAfter(1), 36).detail,
    /result is exit-code/,
  );
  assert.equal(backupFreshnessCheck({ error: 'systemctl is unavailable' }, hoursAfter(1), 36).ok, false);
  assert.equal(backupFreshnessCheck({ skipped: true }, hoursAfter(1), 36).ok, true);
  assert.equal(backupFreshnessCheck(null, hoursAfter(1), 36).ok, false);

  // The runner delegates the verdict instead of parsing the timestamp itself.
  assert.match(monitor, /backupFreshnessCheck\(systemdUnitState\('pawshop-backup\.service'\)/);
  assert.doesNotMatch(monitor, /new Date\(unit\.lastRun\)/);
});

test('backup freshness survives a reboot without hiding a failing unit', () => {
  // The recorded instant is written by the backup itself in UTC, so it carries no
  // timezone abbreviation to interpret - but a value that is not exactly one
  // instant is refused rather than coerced.
  assert.equal(recordedTimestampToIso('2026-09-17T14:18:07.000Z\n'), '2026-09-17T14:18:07.000Z');
  for (const value of [
    '2026-09-17T14:18:07Z', '2026-09-17 14:18:07', '2026-09-17T14:18:07.000+08:00',
    '2026-13-40T25:61:61.000Z', '', '   ', undefined, null, 7,
  ]) assert.equal(recordedTimestampToIso(value), null, String(value));
  // The value Date would silently normalise an out-of-range day for is refused by
  // the parse, so a corrupt file cannot produce a plausible-looking age.
  assert.equal(recordedTimestampToIso('2026-09-31T00:00:00.000Z'), null);

  const at = iso => new Date(iso);
  const now = at('2026-09-17T17:18:07.000Z');

  // The false alarm this exists to remove: after a reboot, systemd reports
  // Result=success with an empty completion timestamp, and the recorded file is
  // the only source that still knows when the last success happened.
  const afterReboot = backupFreshnessCheck(
    { result: 'success', lastRun: '' }, now, 36, { contents: '2026-09-17T14:18:07.000Z\n' },
  );
  assert.equal(afterReboot.ok, true);
  assert.match(afterReboot.detail, /3\.0h ago/);

  // A genuinely stale recorded instant still fails even though the unit is happy.
  const stale = backupFreshnessCheck(
    { result: 'success', lastRun: '' }, now, 36, { contents: '2026-09-15T14:18:07.000Z\n' },
  );
  assert.equal(stale.ok, false);
  assert.match(stale.detail, /limit 36h/);

  // Reading the file must not cost the immediate signal: a failing unit is caught
  // now, not thirty-six hours later when the recorded age finally exceeds the limit.
  const failingUnit = backupFreshnessCheck(
    { result: 'exit-code', lastRun: '' }, now, 36, { contents: '2026-09-17T17:00:07.000Z\n' },
  );
  assert.equal(failingUnit.ok, false);
  assert.match(failingUnit.detail, /result is exit-code/);

  // A configured but unreadable file is a failure, not a silent fallback: falling
  // back would keep reporting a fresh age from a file that never gets written.
  const unreadable = backupFreshnessCheck(
    { result: 'success', lastRun: '' }, now, 36, { error: 'backup timestamp file is missing or unreadable' },
  );
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.detail, /missing or unreadable/);

  const malformed = backupFreshnessCheck(
    { result: 'success', lastRun: '' }, now, 36, { contents: 'not-a-timestamp' },
  );
  assert.equal(malformed.ok, false);
  assert.match(malformed.detail, /recorded backup timestamp is invalid/);

  // Unset keeps the previous systemd-only behaviour, which is what every host that
  // has not adopted the file still runs.
  assert.equal(backupFreshnessCheck({ result: 'success', lastRun: '' }, now, 36).ok, false);
  assert.equal(backupFreshnessCheck({ skipped: true }, now, 36, { contents: 'nonsense' }).ok, true);

  // The monitor reads both sources, and the runner writes the file only after the
  // dump and the offsite upload have both succeeded.
  assert.match(monitor, /process\.env\.PAWSHOP_MONITOR_BACKUP_TIMESTAMP_FILE/);
  assert.match(monitor, /systemdUnitState\('pawshop-backup\.service'\), now, config\.maxBackupAgeHours, recordedBackup/);
  assert.match(scheduledBackup, /const BACKUP_TIMESTAMP_FILE = '\/var\/lib\/pawshop-backup\/last-success\.txt'/);
  const syncImport = scheduledBackup.indexOf("await import('./sync-production-backups.mjs')");
  assert.ok(syncImport > -1);
  assert.ok(scheduledBackup.indexOf('renameSync(stagedTimestamp, BACKUP_TIMESTAMP_FILE)') > syncImport);
  // UMask=0077 would create the file 0600 and the monitor, which runs as another
  // account, would only ever see "unreadable".
  assert.match(scheduledBackup, /chmodSync\(stagedTimestamp, 0o644\)/);
  assert.match(backupService, /^StateDirectory=pawshop-backup$/m);
  assert.match(backupService, /^ReadWritePaths=\/var\/backups\/pawshop$/m);
  assert.match(monitorEnvExample, /^PAWSHOP_MONITOR_BACKUP_TIMESTAMP_FILE=\/var\/lib\/pawshop-backup\/last-success\.txt$/m);
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
  assert.match(monitorService, /^WorkingDirectory=\/usr\/local\/libexec\/pawshop$/m);
  assert.match(monitorService, /ExecStart=\/usr\/bin\/node \/usr\/local\/libexec\/pawshop\/monitor-production\.mjs/);
  assert.doesNotMatch(monitorService, /LoadCredential/);
  // Storefront monitoring must not depend on an activated commerce release: it is
  // the safety net that should exist before commerce is switched on.
  assert.doesNotMatch(monitorService, /srv\/pawshop-commerce/);
  assert.match(monitorEnvExample, /PAWSHOP_MONITOR_SKIP_COMMERCE_CHECKS=1/);
  assert.match(monitorTimer, /^OnCalendar=\*:0\/5$/m);
  assert.match(monitorTimer, /^Persistent=true$/m);
  assert.match(monitorEnvExample, /PAWSHOP_MONITOR_STOREFRONT_ORIGIN=https:\/\//);
  assert.doesNotMatch(monitorEnvExample, /replace-me.*=.*replace-me/);
  for (const line of monitorEnvExample.split('\n').filter(line => line && !line.startsWith('#'))) {
    assert.doesNotMatch(line, /(SECRET|PASSWORD|ACCESS_KEY|TOKEN)=/i, `secret-looking key in example: ${line}`);
  }
});
