'use strict';

// Pure policy for PawShop production monitoring.
// No network, no filesystem, no secrets: every function here is deterministic so
// the monitoring contract can be unit tested without touching a live host.

const DEFAULT_MAX_AGE_HOURS = Object.freeze({
  backup: 36,
  deploy: 24 * 30,
});

const MIN_TLS_DAYS = 14;
const MIN_DISK_FREE_PERCENT = 10;
const ALERT_SUPPRESSION_MINUTES = 30;

// Alert channels speak different dialects, so the payload is built per channel.
// "generic" keeps the raw pawshop-monitor-alert-v1 JSON for an internal endpoint;
// the chat providers only accept their own message schema and would reject the
// raw payload (Slack: invalid_payload, Feishu: non-zero code, Telegram: chat_id
// and text missing). Sending the raw payload to a chat webhook therefore looks
// like a working alert channel while silently delivering nothing.
const ALERT_PROVIDERS = Object.freeze(['generic', 'slack', 'feishu', 'telegram']);
const DEFAULT_ALERT_PROVIDER = 'generic';
const ALERT_TEXT_MAX_CHARS = 1500;

// Every message opens with the same envelope, and the state comes after it.
//
// A chat-side deliverability filter matches on the message text: Feishu's custom
// bot keeps an open webhook from being an open relay by requiring a keyword, and
// it answers HTTP 200 with code 19024 "Key Words Not Found" when no keyword is
// present. Phrasing a recovery differently from an alert therefore drops exactly
// the message that says the incident is over - the operator sees every alarm and
// never an all-clear. Keeping the envelope identical in both cases means any
// keyword drawn from it (the whole envelope, the prefix, or just "PawShop")
// matches both. Verified against the live channel: the previous "[PawShop 恢复]"
// opening was rejected with 19024 while "[PawShop 告警]" was accepted.
const ALERT_ENVELOPE = '[PawShop 告警]';

// Each provider's webhook is pinned to its vendor host. A mistyped or swapped
// alert URL is otherwise a silent way to send host status to the wrong place.
const ALERT_PROVIDER_HOSTS = Object.freeze({
  slack: ['hooks.slack.com'],
  feishu: ['open.feishu.cn', 'open.larksuite.com'],
  telegram: ['api.telegram.org'],
});

// Alerting is the one subsystem whose failure is silent, so it runs over more
// than one channel: a revoked webhook, a deleted group or a vendor outage then
// costs one channel instead of the alarm. Channels are declared as
// "provider:https://host/path", comma separated, in
// PAWSHOP_MONITOR_ALERT_CHANNELS. Webhook URLs never contain commas, so the
// separator is unambiguous.
const ALERT_CHANNEL_SEPARATOR = ',';
const ALERT_CHANNEL_SPEC = /^(generic|slack|feishu|telegram)\s*[:=]\s*(https:\/\/\S+)$/;

// Monitoring exit codes: 0 healthy, 1 checks failed, 2 alerting itself is broken.
const EXIT_CODES = Object.freeze({
  healthy: 0,
  checksFailed: 1,
  alertDeliveryFailed: 2,
});

function requireHttpsOrigin(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be set.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use https.`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials.`);
  if (parsed.search || parsed.hash) throw new Error(`${label} must not contain a query or fragment.`);
  if (parsed.pathname !== '/') throw new Error(`${label} must be an origin without a path.`);
  return parsed.origin;
}

function requireLoopbackOrigin(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be set.`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (parsed.protocol !== 'http:') throw new Error(`${label} must use http on loopback.`);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`${label} must be a loopback origin.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be a bare loopback origin.`);
  }
  return parsed.origin;
}

function requirePositiveInt(value, label, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

// A webhook may carry a per-channel path (and therefore a token), so it is
// validated in place and never rewritten, truncated or logged.
function validateAlertUrl(webhookUrl, provider, label) {
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use https.`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials.`);
  const allowedHosts = ALERT_PROVIDER_HOSTS[provider];
  if (allowedHosts && !allowedHosts.includes(parsed.hostname)) {
    throw new Error(`${label} must point at ${allowedHosts.join(' or ')} for the ${provider} provider.`);
  }
  return webhookUrl;
}

// Returns the ordered, frozen channel list. Legacy single-channel configuration
// (PAWSHOP_MONITOR_ALERT_PROVIDER + PAWSHOP_MONITOR_ALERT_WEBHOOK) is still
// accepted and yields exactly one channel.
function resolveAlertChannels(env, telegramChatId) {
  const channelsValue = env.PAWSHOP_MONITOR_ALERT_CHANNELS;
  const legacyUrl = env.PAWSHOP_MONITOR_ALERT_WEBHOOK;
  const providerValue = env.PAWSHOP_MONITOR_ALERT_PROVIDER;
  const legacyProvider = providerValue === undefined || providerValue === '' ? DEFAULT_ALERT_PROVIDER : String(providerValue);
  if (!ALERT_PROVIDERS.includes(legacyProvider)) {
    throw new Error(`PAWSHOP_MONITOR_ALERT_PROVIDER must be one of: ${ALERT_PROVIDERS.join(', ')}.`);
  }

  const declared = channelsValue === undefined || channelsValue === '' ? [] : String(channelsValue).split(ALERT_CHANNEL_SEPARATOR);
  const entries = declared.map((entry) => entry.trim()).filter((entry) => entry !== '');
  if (entries.length > 0) {
    // Two competing declarations is an operator error, not something to guess at.
    if (legacyUrl !== undefined && legacyUrl !== '') {
      throw new Error('Set either PAWSHOP_MONITOR_ALERT_CHANNELS or PAWSHOP_MONITOR_ALERT_WEBHOOK, not both.');
    }
    const seen = new Map();
    const channels = entries.map((entry) => {
      const match = ALERT_CHANNEL_SPEC.exec(entry);
      if (match === null) {
        throw new Error('PAWSHOP_MONITOR_ALERT_CHANNELS entries must look like provider:https://host/path.');
      }
      const provider = match[1];
      const url = validateAlertUrl(match[2], provider, `PAWSHOP_MONITOR_ALERT_CHANNELS (${provider})`);
      const count = (seen.get(provider) || 0) + 1;
      seen.set(provider, count);
      // Labels are for log lines only: two feishu groups must be distinguishable.
      return Object.freeze({ label: count === 1 ? provider : `${provider}#${count}`, provider, url });
    });
    if (channels.some((channel) => channel.provider === 'telegram') && !telegramChatId) {
      throw new Error('PAWSHOP_MONITOR_TELEGRAM_CHAT_ID must be set when the telegram provider is used.');
    }
    return Object.freeze(channels);
  }

  if (legacyUrl !== undefined && legacyUrl !== '') {
    const url = validateAlertUrl(legacyUrl, legacyProvider, 'PAWSHOP_MONITOR_ALERT_WEBHOOK');
    if (legacyProvider === 'telegram' && !telegramChatId) {
      throw new Error('PAWSHOP_MONITOR_TELEGRAM_CHAT_ID must be set when the telegram provider is used.');
    }
    return Object.freeze([Object.freeze({ label: legacyProvider, provider: legacyProvider, url })]);
  }

  if (legacyProvider !== DEFAULT_ALERT_PROVIDER) {
    // A channel that is declared but has no endpoint is a half-configured alert
    // path; fail closed rather than silently monitoring without an alarm.
    throw new Error('PAWSHOP_MONITOR_ALERT_PROVIDER requires PAWSHOP_MONITOR_ALERT_WEBHOOK to be set.');
  }
  return Object.freeze([]);
}

// Fail-closed: monitoring must never be pointed at localhost or a test host in
// production, and it must never treat a plaintext storefront as valid.
function validateMonitoringConfig(env) {
  if (!env || typeof env !== 'object') throw new Error('Monitoring environment is missing.');
  const storefrontOrigin = requireHttpsOrigin(env.PAWSHOP_MONITOR_STOREFRONT_ORIGIN, 'PAWSHOP_MONITOR_STOREFRONT_ORIGIN');
  if (/localhost|127\.0\.0\.1|\.invalid$|\.test$|example\.com$/i.test(new URL(storefrontOrigin).hostname)) {
    throw new Error('PAWSHOP_MONITOR_STOREFRONT_ORIGIN must be the real public host.');
  }
  const commerceOrigin = requireLoopbackOrigin(env.PAWSHOP_MONITOR_COMMERCE_ORIGIN, 'PAWSHOP_MONITOR_COMMERCE_ORIGIN');

  const chatIdValue = env.PAWSHOP_MONITOR_TELEGRAM_CHAT_ID;
  const telegramChatId = chatIdValue === undefined || chatIdValue === '' ? null : String(chatIdValue).trim();
  const alertChannels = resolveAlertChannels(env, telegramChatId);

  const databaseHost = env.PAWSHOP_MONITOR_DATABASE_HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(databaseHost)) {
    throw new Error('PAWSHOP_MONITOR_DATABASE_HOST must be loopback.');
  }

  return Object.freeze({
    storefrontOrigin,
    commerceOrigin,
    alertChannels,
    // Kept for callers that predate multi-channel: they describe the single
    // channel case and are null/absent when several channels are configured.
    alertWebhook: alertChannels.length === 1 ? alertChannels[0].url : null,
    alertProvider: alertChannels.length === 1 ? alertChannels[0].provider : DEFAULT_ALERT_PROVIDER,
    telegramChatId,
    databaseHost,
    databasePort: requirePositiveInt(env.PAWSHOP_MONITOR_DATABASE_PORT, 'PAWSHOP_MONITOR_DATABASE_PORT', 5432),
    redisPort: requirePositiveInt(env.PAWSHOP_MONITOR_REDIS_PORT, 'PAWSHOP_MONITOR_REDIS_PORT', 6379),
    maxBackupAgeHours: requirePositiveInt(env.PAWSHOP_MONITOR_MAX_BACKUP_AGE_HOURS, 'PAWSHOP_MONITOR_MAX_BACKUP_AGE_HOURS', DEFAULT_MAX_AGE_HOURS.backup),
    minTlsDays: requirePositiveInt(env.PAWSHOP_MONITOR_MIN_TLS_DAYS, 'PAWSHOP_MONITOR_MIN_TLS_DAYS', MIN_TLS_DAYS),
    minDiskFreePercent: requirePositiveInt(env.PAWSHOP_MONITOR_MIN_DISK_FREE_PERCENT, 'PAWSHOP_MONITOR_MIN_DISK_FREE_PERCENT', MIN_DISK_FREE_PERCENT),
    alertSuppressionMinutes: requirePositiveInt(env.PAWSHOP_MONITOR_ALERT_SUPPRESSION_MINUTES, 'PAWSHOP_MONITOR_ALERT_SUPPRESSION_MINUTES', ALERT_SUPPRESSION_MINUTES),
    timeoutMs: requirePositiveInt(env.PAWSHOP_MONITOR_TIMEOUT_MS, 'PAWSHOP_MONITOR_TIMEOUT_MS', 10000),
    latencyBudgetMs: requirePositiveInt(env.PAWSHOP_MONITOR_LATENCY_BUDGET_MS, 'PAWSHOP_MONITOR_LATENCY_BUDGET_MS', 3000),
  });
}

// Redacts anything that must never reach a log line or an alert payload.
function redactUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '<unparseable-url>';
  }
}

function checkResult(name, ok, detail, extra) {
  if (typeof name !== 'string' || name.length === 0) throw new Error('A check name is required.');
  return Object.freeze({
    name,
    ok: Boolean(ok),
    detail: typeof detail === 'string' ? detail.slice(0, 300) : '',
    ...(extra && typeof extra === 'object' ? { metrics: extra } : {}),
  });
}

const REQUIRED_SECURITY_HEADERS = Object.freeze([
  'strict-transport-security',
  'x-content-type-options',
]);

function missingSecurityHeaders(headerNames) {
  const normalized = new Set((headerNames || []).map(name => String(name).toLowerCase()));
  return REQUIRED_SECURITY_HEADERS.filter(name => !normalized.has(name));
}

function daysUntilExpiry(notAfterIso, now) {
  const expiry = new Date(notAfterIso);
  if (Number.isNaN(expiry.getTime())) throw new Error('Certificate expiry date is invalid.');
  return Math.floor((expiry.getTime() - now.getTime()) / 86400000);
}

function backupAgeHours(lastSuccessIso, now) {
  const lastSuccess = new Date(lastSuccessIso);
  if (Number.isNaN(lastSuccess.getTime())) throw new Error('Last backup timestamp is invalid.');
  return (now.getTime() - lastSuccess.getTime()) / 3600000;
}

// systemd renders timestamps as local wall-clock time with a timezone
// abbreviation ("Thu 2026-09-17 14:18:07 CST"). Handing that string straight to
// Date resolves the abbreviation as US Central, which on this host sits fourteen
// hours away from the real zone, so every age came out fourteen hours too fresh
// and a fifty-hour-old backup satisfied a thirty-six hour limit. The monitor runs
// on the same host as systemd, so the wall-clock fields are read as local time
// and the ambiguous abbreviation is ignored. Absent or unexpected values yield
// null, which the caller reports as a failed check.
function systemdTimestampToIso(value) {
  if (typeof value !== 'string') return null;
  const match = /^[A-Za-z]{3} (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: \S+)?$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part));
  const parsed = new Date(year, month - 1, day, hour, minute, second);
  // Reject field values the Date constructor silently normalised (month 13,
  // hour 25): a normalised value would be a plausible-looking wrong instant.
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day ||
      parsed.getHours() !== hour || parsed.getMinutes() !== minute || parsed.getSeconds() !== second) {
    return null;
  }
  return parsed.toISOString();
}

// The backup freshness verdict is decided here, not in the monitor, because the
// systemd properties it reads are runtime state: a unit that has not run since
// the host booted still reports Result=success while its completion timestamp is
// empty. Parsing that empty timestamp inline killed the whole monitoring run
// with an unhandled RangeError on the first real use, and a crashed monitor
// dispatches no alert at all - a silent death, which is the one outcome the
// fail-closed design exists to prevent. An unknown age is reported as a failed
// check with a reason, never as a passing one.
function backupFreshnessCheck(unitState, now, maxAgeHours) {
  if (!unitState || typeof unitState !== 'object') {
    return checkResult('backup_freshness', false, 'the backup unit state could not be read');
  }
  if (unitState.skipped) {
    return checkResult('backup_freshness', true, 'systemd checks skipped by explicit configuration');
  }
  if (unitState.error) return checkResult('backup_freshness', false, unitState.error);
  if (unitState.result !== 'success') {
    return checkResult('backup_freshness', false, `last backup unit result is ${unitState.result}`);
  }
  const lastRun = systemdTimestampToIso(unitState.lastRun);
  if (lastRun === null) {
    return checkResult('backup_freshness', false, 'the backup unit has no completed run recorded since the host booted');
  }
  const ageHours = backupAgeHours(lastRun, now);
  return checkResult(
    'backup_freshness',
    ageHours <= maxAgeHours,
    `last successful backup ${ageHours.toFixed(1)}h ago (limit ${maxAgeHours}h)`,
    { age_hours: Number(ageHours.toFixed(1)) },
  );
}

function summarize(results) {
  if (!Array.isArray(results) || results.length === 0) throw new Error('At least one check result is required.');
  const failures = results.filter(result => !result.ok);
  return Object.freeze({
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    failing: failures.map(result => result.name),
    results,
  });
}

// The closed-route invariant is a first-class monitoring target: the public
// store APIs must never answer 200 in admin-only mode.
function storeRouteIsClosed(status) {
  if (!Number.isInteger(status) || status <= 0) return false;
  return status !== 200 && status !== 201 && status !== 204;
}

function adminRouteRequiresAuth(status) {
  return status === 401 || status === 403;
}

function shouldDispatchAlert(previousState, summary, now, suppressionMinutes) {
  if (summary.failed === 0) {
    // Always report recovery once, then stay quiet.
    return Boolean(previousState && previousState.status === 'failing');
  }
  if (!previousState || previousState.status !== 'failing') return true;
  const signature = summary.failing.join(',');
  if (previousState.signature !== signature) return true;
  const lastAlert = new Date(previousState.last_alert_at || 0).getTime();
  if (Number.isNaN(lastAlert)) return true;
  return now.getTime() - lastAlert >= suppressionMinutes * 60000;
}

function nextAlertState(previousState, summary, now, dispatched) {
  if (summary.failed === 0) {
    return Object.freeze({ status: 'healthy', signature: '', last_alert_at: null });
  }
  return Object.freeze({
    status: 'failing',
    signature: summary.failing.join(','),
    last_alert_at: dispatched ? now.toISOString() : (previousState && previousState.last_alert_at) || null,
  });
}

// Alert payloads carry check names, statuses and metrics only. No environment
// values, credentials, headers or response bodies are ever included.
function buildAlertPayload(summary, now, storefrontOrigin) {
  return Object.freeze({
    schema: 'pawshop-monitor-alert-v1',
    at: now.toISOString(),
    storefront: storefrontOrigin,
    status: summary.failed === 0 ? 'recovered' : 'failing',
    checked: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    failing: summary.failing,
    details: summary.results
      .filter(result => !result.ok)
      .map(result => ({ name: result.name, detail: result.detail, metrics: result.metrics || {} })),
  });
}

// Chat channels need a readable message, not the machine payload. Check names are
// kept verbatim so an alert always matches the journal and the state file.
function formatAlertText(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('An alert payload is required.');
  const failing = payload.status !== 'recovered';
  const lines = [
    failing
      ? `${ALERT_ENVELOPE} ${payload.failed}/${payload.checked} 项检查失败`
      : `${ALERT_ENVELOPE} 已恢复: ${payload.checked}/${payload.checked} 项检查全部通过`,
    `时间(UTC): ${payload.at}`,
    `站点: ${payload.storefront}`,
  ];
  if (failing) {
    lines.push(`失败项: ${(payload.failing || []).join(', ')}`);
    for (const detail of payload.details || []) {
      lines.push(`- ${detail.name}: ${detail.detail || 'no detail'}`);
    }
  }
  lines.push('主机排查: journalctl -u pawshop-monitor.service -n 50');
  return lines.join('\n').slice(0, ALERT_TEXT_MAX_CHARS);
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    const parsed = JSON.parse(text.slice(0, 20000));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Feishu answers HTTP 200 with a non-zero code when it dislikes the message, so
// the status line alone would report a delivered alert that never arrived.
function feishuAccepted(bodyText) {
  const parsed = parseJsonObject(bodyText);
  if (parsed === null) return false;
  return parsed.code === 0 || parsed.StatusCode === 0;
}

function telegramAccepted(bodyText) {
  const parsed = parseJsonObject(bodyText);
  return parsed !== null && parsed.ok === true;
}

// Only the numeric verdict reaches the journal. The raw response body can echo
// request details back and is never logged or stored, but a bare "did not accept
// the payload" is undiagnosable at 3am: the provider's own code is what says why.
const ALERT_PROVIDER_CODE_HINTS = Object.freeze({
  19021: 'provider rejected the message: this bot requires a signature or timestamp the monitor does not send',
  19024: 'provider rejected the message: this bot has a keyword requirement the alert text does not contain',
});

function alertProviderErrorCode(bodyText) {
  const parsed = parseJsonObject(bodyText);
  if (parsed === null) return null;
  for (const key of ['code', 'StatusCode', 'error_code']) {
    const value = parsed[key];
    if (Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  }
  return null;
}

function describeAlertProviderCode(code) {
  if (!Number.isInteger(code)) return '';
  const hint = ALERT_PROVIDER_CODE_HINTS[code];
  return hint === undefined ? '' : `: ${hint}`;
}

// Accepts either a resolved channel ({label, provider, url}) or the legacy
// single-channel config ({alertProvider, telegramChatId}); the provider key is
// read from whichever is present.
function buildAlertRequest(config, payload) {
  if (!config || typeof config !== 'object') throw new Error('Alert configuration is required.');
  const provider = config.provider || config.alertProvider || DEFAULT_ALERT_PROVIDER;
  const headers = Object.freeze({ 'content-type': 'application/json', 'user-agent': 'pawshop-monitor/1' });
  if (provider === 'generic') return { headers, body: JSON.stringify(payload) };
  const text = formatAlertText(payload);
  if (provider === 'slack') return { headers, body: JSON.stringify({ text }) };
  if (provider === 'feishu') return { headers, body: JSON.stringify({ msg_type: 'text', content: { text } }) };
  if (provider === 'telegram') {
    if (!config.telegramChatId) throw new Error('Telegram alerts require PAWSHOP_MONITOR_TELEGRAM_CHAT_ID.');
    return { headers, body: JSON.stringify({ chat_id: String(config.telegramChatId), text, disable_web_page_preview: true }) };
  }
  throw new Error(`Unsupported alert provider: ${provider}`);
}

// Delivery is only accepted when the provider itself acknowledges the message.
function alertDeliveryAccepted(provider, status, bodyText) {
  if (!Number.isInteger(status) || status <= 0 || status >= 400) return false;
  if (provider === 'feishu') return feishuAccepted(bodyText);
  if (provider === 'telegram') return telegramAccepted(bodyText);
  return true;
}

function formatLogLine(level, message, now) {
  const normalized = String(level).toUpperCase();
  if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(normalized)) throw new Error('Unsupported log level.');
  return `${now.toISOString()} ${normalized} ${message}`;
}

module.exports = {
  ALERT_ENVELOPE,
  ALERT_PROVIDERS,
  ALERT_TEXT_MAX_CHARS,
  DEFAULT_MAX_AGE_HOURS,
  EXIT_CODES,
  MIN_DISK_FREE_PERCENT,
  MIN_TLS_DAYS,
  REQUIRED_SECURITY_HEADERS,
  adminRouteRequiresAuth,
  alertDeliveryAccepted,
  alertProviderErrorCode,
  backupAgeHours,
  backupFreshnessCheck,
  buildAlertPayload,
  buildAlertRequest,
  checkResult,
  daysUntilExpiry,
  describeAlertProviderCode,
  feishuAccepted,
  formatAlertText,
  formatLogLine,
  missingSecurityHeaders,
  nextAlertState,
  redactUrl,
  resolveAlertChannels,
  shouldDispatchAlert,
  storeRouteIsClosed,
  summarize,
  systemdTimestampToIso,
  telegramAccepted,
  validateAlertUrl,
  validateMonitoringConfig,
};
