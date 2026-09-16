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

// Fail-closed: monitoring must never be pointed at localhost or a test host in
// production, and it must never treat a plaintext storefront as valid.
function validateMonitoringConfig(env) {
  if (!env || typeof env !== 'object') throw new Error('Monitoring environment is missing.');
  const storefrontOrigin = requireHttpsOrigin(env.PAWSHOP_MONITOR_STOREFRONT_ORIGIN, 'PAWSHOP_MONITOR_STOREFRONT_ORIGIN');
  if (/localhost|127\.0\.0\.1|\.invalid$|\.test$|example\.com$/i.test(new URL(storefrontOrigin).hostname)) {
    throw new Error('PAWSHOP_MONITOR_STOREFRONT_ORIGIN must be the real public host.');
  }
  const commerceOrigin = requireLoopbackOrigin(env.PAWSHOP_MONITOR_COMMERCE_ORIGIN, 'PAWSHOP_MONITOR_COMMERCE_ORIGIN');

  // A webhook may carry a per-channel path (and therefore a token), so it is
  // validated in place and never rewritten or logged.
  const webhookUrl = env.PAWSHOP_MONITOR_ALERT_WEBHOOK;
  let alertWebhook = null;
  if (webhookUrl !== undefined && webhookUrl !== '') {
    let parsed;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      throw new Error('PAWSHOP_MONITOR_ALERT_WEBHOOK must be an absolute URL.');
    }
    if (parsed.protocol !== 'https:') throw new Error('PAWSHOP_MONITOR_ALERT_WEBHOOK must use https.');
    if (parsed.username || parsed.password) throw new Error('PAWSHOP_MONITOR_ALERT_WEBHOOK must not contain credentials.');
    alertWebhook = webhookUrl;
  }

  const databaseHost = env.PAWSHOP_MONITOR_DATABASE_HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(databaseHost)) {
    throw new Error('PAWSHOP_MONITOR_DATABASE_HOST must be loopback.');
  }

  return Object.freeze({
    storefrontOrigin,
    commerceOrigin,
    alertWebhook,
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

function formatLogLine(level, message, now) {
  const normalized = String(level).toUpperCase();
  if (!['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(normalized)) throw new Error('Unsupported log level.');
  return `${now.toISOString()} ${normalized} ${message}`;
}

module.exports = {
  DEFAULT_MAX_AGE_HOURS,
  EXIT_CODES,
  MIN_DISK_FREE_PERCENT,
  MIN_TLS_DAYS,
  REQUIRED_SECURITY_HEADERS,
  adminRouteRequiresAuth,
  backupAgeHours,
  buildAlertPayload,
  checkResult,
  daysUntilExpiry,
  formatLogLine,
  missingSecurityHeaders,
  nextAlertState,
  redactUrl,
  shouldDispatchAlert,
  storeRouteIsClosed,
  summarize,
  validateMonitoringConfig,
};
