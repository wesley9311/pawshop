// PawShop production monitor.
//
// Read-only checks over the public storefront, the loopback-only commerce
// runtime, the private data services, the backup freshness and the host disk.
// Alerts go to a generic HTTPS webhook; when no webhook is configured the run
// is log-only (fail-closed: monitoring never silently pretends to alert).
//
// Never logs or transmits credentials, headers, response bodies or customer
// data. Bounded timeout on every network and subprocess call.

import { execFileSync } from 'node:child_process';
import { statfsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  EXIT_CODES, adminRouteRequiresAuth, backupAgeHours, buildAlertPayload, checkResult, daysUntilExpiry,
  formatLogLine, missingSecurityHeaders, nextAlertState, redactUrl, shouldDispatchAlert,
  storeRouteIsClosed, summarize, validateMonitoringConfig,
} = require('./monitoring-policy.cjs');

const now = new Date();
const config = validateMonitoringConfig(process.env);
const logLines = [];

// The commerce runtime does not exist until the first commerce release is
// activated, so probing it before then would report a permanent outage. The
// skip is opt-in, is announced in the log on every run, and must be removed when
// commerce goes live; monitoring never silently pretends a check passed.
const skipCommerceChecks = process.env.PAWSHOP_MONITOR_SKIP_COMMERCE_CHECKS === '1';

function log(level, message) {
  const line = formatLogLine(level, message, new Date());
  logLines.push(line);
  process.stdout.write(`${line}\n`);
}

async function timedFetch(url, options = {}) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: { 'user-agent': 'pawshop-monitor/1' },
    ...options,
  });
  // Bodies are consumed but never logged or stored.
  try {
    await response.arrayBuffer();
  } catch {
    /* an unreadable body must not mask the status code */
  }
  return { status: response.status, headers: response.headers, latencyMs: Date.now() - startedAt };
}

function tcpProbe(host, port) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const finish = ok => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(config.timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function tlsExpiryDays(hostname) {
  return new Promise(resolve => {
    const request = httpsRequest({ host: hostname, port: 443, method: 'HEAD', path: '/', timeout: config.timeoutMs }, response => {
      const certificate = response.socket.getPeerCertificate();
      const notAfter = certificate && (certificate.valid_to || certificate.validTo);
      response.destroy();
      resolve(notAfter ? daysUntilExpiry(new Date(notAfter).toISOString(), now) : null);
    });
    request.once('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.once('error', () => resolve(null));
    request.end();
  });
}

function systemdUnitState(unit) {
  if (process.env.PAWSHOP_MONITOR_SKIP_SYSTEMD_CHECKS === '1') return { skipped: true };
  try {
    const output = execFileSync('systemctl', ['show', unit, '--property=Result', '--property=ExecMainExitTimestamp', '--property=ActiveState'], {
      encoding: 'utf8', timeout: config.timeoutMs * 2,
    });
    const properties = Object.fromEntries(output.trim().split('\n').map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return { result: properties.Result, lastRun: properties.ExecMainExitTimestamp, activeState: properties.ActiveState };
  } catch {
    return { error: 'systemctl is unavailable or the unit could not be inspected.' };
  }
}

async function runChecks() {
  const results = [];
  const storefront = new URL(config.storefrontOrigin);

  try {
    const response = await timedFetch(`${config.storefrontOrigin}/`);
    results.push(checkResult(
      'storefront_https',
      response.status === 200,
      `public site returned ${response.status}`,
      { status: response.status, latency_ms: response.latencyMs },
    ));
    results.push(checkResult(
      'storefront_latency',
      response.latencyMs <= config.latencyBudgetMs,
      `first byte budget ${config.latencyBudgetMs}ms`,
      { latency_ms: response.latencyMs },
    ));
    const missing = missingSecurityHeaders([...response.headers.keys()]);
    results.push(checkResult(
      'storefront_security_headers',
      missing.length === 0,
      missing.length === 0 ? '' : `missing security headers: ${missing.join(', ')}`,
      { missing: missing.join(',') },
    ));
  } catch (error) {
    results.push(checkResult('storefront_https', false, `public site unreachable: ${error.name}`));
  }

  try {
    const plainOrigin = `${storefront.protocol === 'https:' ? 'http:' : 'https:'}//${storefront.host}`;
    const response = await timedFetch(`${plainOrigin}/`);
    const location = response.headers.get('location') || '';
    results.push(checkResult(
      'storefront_https_redirect',
      [301, 302, 307, 308].includes(response.status) && location.startsWith('https://'),
      `plaintext request returned ${response.status}${location ? ` -> ${redactUrl(location)}` : ''}`,
      { status: response.status },
    ));
  } catch (error) {
    results.push(checkResult('storefront_https_redirect', false, `plaintext probe failed: ${error.name}`));
  }

  const expiryDays = await tlsExpiryDays(storefront.hostname);
  results.push(checkResult(
    'tls_certificate',
    expiryDays !== null && expiryDays >= config.minTlsDays,
    expiryDays === null ? 'certificate expiry could not be read' : `certificate expires in ${expiryDays} day(s)`,
    expiryDays === null ? {} : { days_remaining: expiryDays },
  ));

  if (skipCommerceChecks) {
    log('WARN', 'commerce checks are skipped by explicit configuration; unset PAWSHOP_MONITOR_SKIP_COMMERCE_CHECKS once a commerce release is active');
    for (const name of ['commerce_health', 'store_api_closed', 'admin_requires_auth']) {
      results.push(checkResult(name, true, 'commerce checks skipped by explicit configuration'));
    }
  } else {
    try {
      const response = await timedFetch(`${config.commerceOrigin}/health`);
      results.push(checkResult(
        'commerce_health',
        response.status === 200,
        `commerce health returned ${response.status}`,
        { status: response.status, latency_ms: response.latencyMs },
      ));
    } catch (error) {
      results.push(checkResult('commerce_health', false, `commerce health unreachable: ${error.name}`));
    }

    try {
      const response = await timedFetch(`${config.commerceOrigin}/store/products`, { headers: { 'user-agent': 'pawshop-monitor/1', 'x-publishable-api-key': 'monitor-probe' } });
      results.push(checkResult(
        'store_api_closed',
        storeRouteIsClosed(response.status),
        `store route answered ${response.status}`,
        { status: response.status },
      ));
    } catch (error) {
      results.push(checkResult('store_api_closed', false, `store route probe failed: ${error.name}`));
    }

    try {
      const response = await timedFetch(`${config.commerceOrigin}/admin/products`);
      results.push(checkResult(
        'admin_requires_auth',
        adminRouteRequiresAuth(response.status),
        `unauthenticated admin request answered ${response.status}`,
        { status: response.status },
      ));
    } catch (error) {
      results.push(checkResult('admin_requires_auth', false, `admin auth probe failed: ${error.name}`));
    }
  }

  const databaseReachable = await tcpProbe(config.databaseHost, config.databasePort);
  results.push(checkResult(
    'database_connectivity',
    databaseReachable,
    databaseReachable ? '' : `postgresql loopback port ${config.databasePort} is not accepting connections`,
    { port: config.databasePort },
  ));
  const redisReachable = await tcpProbe(config.databaseHost, config.redisPort);
  results.push(checkResult(
    'redis_connectivity',
    redisReachable,
    redisReachable ? '' : `redis loopback port ${config.redisPort} is not accepting connections`,
    { port: config.redisPort },
  ));

  const backupTimestampFile = process.env.PAWSHOP_MONITOR_BACKUP_TIMESTAMP_FILE;
  if (backupTimestampFile) {
    try {
      const recorded = readFileSync(backupTimestampFile, 'utf8').trim();
      const ageHours = backupAgeHours(recorded, now);
      results.push(checkResult(
        'backup_freshness',
        ageHours <= config.maxBackupAgeHours,
        `last backup ${ageHours.toFixed(1)}h ago (limit ${config.maxBackupAgeHours}h)`,
        { age_hours: Number(ageHours.toFixed(1)) },
      ));
    } catch {
      results.push(checkResult('backup_freshness', false, 'backup timestamp file is missing or unreadable'));
    }
  } else {
    const unit = systemdUnitState('pawshop-backup.service');
    if (unit.skipped) {
      results.push(checkResult('backup_freshness', true, 'systemd checks skipped by explicit configuration'));
    } else if (unit.error) {
      results.push(checkResult('backup_freshness', false, unit.error));
    } else if (unit.result !== 'success') {
      results.push(checkResult('backup_freshness', false, `last backup unit result is ${unit.result}`));
    } else {
      const ageHours = backupAgeHours(new Date(unit.lastRun).toISOString(), now);
      results.push(checkResult(
        'backup_freshness',
        ageHours <= config.maxBackupAgeHours,
        `last successful backup ${ageHours.toFixed(1)}h ago (limit ${config.maxBackupAgeHours}h)`,
        { age_hours: Number(ageHours.toFixed(1)) },
      ));
    }
  }

  try {
    const stats = statfsSync('/');
    const freePercent = (Number(stats.bavail) / Number(stats.blocks)) * 100;
    results.push(checkResult(
      'disk_space',
      freePercent >= config.minDiskFreePercent,
      `root filesystem free space ${freePercent.toFixed(1)}% (minimum ${config.minDiskFreePercent}%)`,
      { free_percent: Number(freePercent.toFixed(1)) },
    ));
  } catch {
    results.push(checkResult('disk_space', false, 'root filesystem statistics unavailable'));
  }

  return results;
}

async function dispatchAlert(payload) {
  if (!config.alertWebhook) {
    log('WARN', 'alert webhook is not configured; alert recorded locally only');
    return { dispatched: false, configured: false };
  }
  try {
    const response = await fetch(config.alertWebhook, {
      method: 'POST',
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: { 'content-type': 'application/json', 'user-agent': 'pawshop-monitor/1' },
      body: JSON.stringify(payload),
    });
    if (response.status >= 400) {
      log('ERROR', `alert webhook rejected the payload with status ${response.status}`);
      return { dispatched: false, configured: true };
    }
    log('INFO', 'alert webhook accepted the payload');
    return { dispatched: true, configured: true };
  } catch (error) {
    log('ERROR', `alert webhook delivery failed: ${error.name}`);
    return { dispatched: false, configured: true };
  }
}

function readAlertState(stateFile) {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function writeAlertState(stateFile, state) {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, stateFile);
}

const results = await runChecks();
const summary = summarize(results);
const stateFile = process.env.PAWSHOP_MONITOR_STATE_FILE || join('/var/lib/pawshop-monitor', 'alert-state.json');
const previousState = readAlertState(stateFile);
const dispatch = shouldDispatchAlert(previousState, summary, now, config.alertSuppressionMinutes);
let dispatchResult = { dispatched: false, configured: Boolean(config.alertWebhook) };
if (dispatch) {
  dispatchResult = await dispatchAlert(buildAlertPayload(summary, now, config.storefrontOrigin));
}
try {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeAlertState(stateFile, nextAlertState(previousState, summary, now, dispatchResult.dispatched));
} catch (error) {
  log('ERROR', `alert state could not be persisted: ${error.message}`);
}

for (const result of results) {
  log('DEBUG', `check ${result.name} ${result.ok ? 'ok' : 'failed'}${result.detail ? ` (${result.detail})` : ''}`);
}
if (summary.failed === 0) {
  log('INFO', `monitoring passed ${summary.passed}/${summary.total} checks`);
  process.exit(EXIT_CODES.healthy);
}
const alertDeliveryFailed = dispatchResult.configured && !dispatchResult.dispatched;
log('ERROR', `monitoring failed ${summary.failed}/${summary.total} checks: ${summary.failing.join(', ')}`);
process.exit(alertDeliveryFailed ? EXIT_CODES.alertDeliveryFailed : EXIT_CODES.checksFailed);
