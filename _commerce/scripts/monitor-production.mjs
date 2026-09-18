// PawShop production monitor.
//
// Read-only checks over the public storefront, the loopback-only commerce
// runtime, the private data services, the backup freshness and the host disk.
// Alerts go to every configured channel, each formatted for its own platform
// (generic JSON, Slack, Feishu or Telegram); when no channel is configured the
// run is log-only (fail-closed: monitoring never silently pretends to alert).
//
// Never logs or transmits credentials, headers or customer data. Provider
// response bodies are read to confirm acceptance and are never logged or stored.
// Bounded timeout on every network and subprocess call.

import { execFileSync } from 'node:child_process';
import { statfsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  EXIT_CODES, adminRouteRequiresAuth, alertDeliveryAccepted, alertProviderErrorCode,
  backupFreshnessCheck,
  buildAlertPayload,
  buildAlertRequest, checkResult, daysUntilExpiry, describeAlertProviderCode,
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

// Every run records which channels would carry an alert, by label only: a
// webhook URL is a write credential and never reaches the journal.
log('INFO', config.alertChannels.length === 0
  ? 'alerting is log-only: no channel is configured'
  : `alert channels configured: ${config.alertChannels.map((channel) => channel.label).join(', ')}`);

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

  // Both sources are read, not one or the other: the unit supplies an immediate
  // failure verdict, the file supplies an age that survives a reboot. The file is
  // configured here rather than assumed so that a host which has not adopted it
  // keeps the previous systemd-only behaviour.
  const backupTimestampFile = process.env.PAWSHOP_MONITOR_BACKUP_TIMESTAMP_FILE;
  let recordedBackup;
  if (backupTimestampFile) {
    try {
      recordedBackup = { contents: readFileSync(backupTimestampFile, 'utf8') };
    } catch {
      recordedBackup = { error: 'backup timestamp file is missing or unreadable' };
    }
  }
  results.push(backupFreshnessCheck(systemdUnitState('pawshop-backup.service'), now, config.maxBackupAgeHours, recordedBackup));

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

async function deliverToChannel(channel, payload) {
  let request;
  try {
    request = buildAlertRequest({ provider: channel.provider, telegramChatId: config.telegramChatId }, payload);
  } catch (error) {
    log('ERROR', `alert channel ${channel.label} could not build a payload: ${error.message}`);
    return false;
  }
  try {
    const response = await fetch(channel.url, {
      method: 'POST',
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: request.headers,
      body: request.body,
    });
    // Chat providers answer HTTP 200 with an error code in the body, so the body
    // decides acceptance too. It is read once, never logged and never stored.
    const bodyText = await response.text().catch(() => '');
    if (!alertDeliveryAccepted(channel.provider, response.status, bodyText)) {
      // The provider's numeric code is the only part of the body that may be
      // logged; without it a rejected channel is undiagnosable from the journal.
      const providerCode = alertProviderErrorCode(bodyText);
      log('ERROR', `alert channel ${channel.label} did not accept the payload (status ${response.status}, `
        + `provider code ${providerCode === null ? 'none' : providerCode}${describeAlertProviderCode(providerCode)})`);
      return false;
    }
    log('INFO', `alert channel ${channel.label} accepted the payload`);
    return true;
  } catch (error) {
    log('ERROR', `alert channel ${channel.label} delivery failed: ${error.name}`);
    return false;
  }
}

// Alerting is the one subsystem whose failure is silent, so it runs over every
// configured channel: a revoked webhook, a deleted group or a vendor outage then
// costs one channel instead of the alarm. A single acknowledgement means the
// owner was notified; the channels that stayed quiet are named in the log so a
// dead channel cannot hide behind a healthy one.
async function dispatchAlert(payload) {
  if (config.alertChannels.length === 0) {
    log('WARN', 'no alert channel is configured; alert recorded locally only');
    return { dispatched: false, configured: false, delivered: [], failed: [] };
  }
  const delivered = [];
  const failed = [];
  for (const channel of config.alertChannels) {
    // Sequential on purpose: a burst of parallel posts to one provider can trip
    // its rate limit and cost the channel that would have worked.
    // eslint-disable-next-line no-await-in-loop
    if (await deliverToChannel(channel, payload)) delivered.push(channel.label);
    else failed.push(channel.label);
  }
  if (failed.length > 0) {
    log('WARN', `alert reached ${delivered.length}/${config.alertChannels.length} channels; no acknowledgement from: ${failed.join(', ')}`);
  }
  return { dispatched: delivered.length > 0, configured: true, delivered, failed };
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
// "attempted" is what separates a suppressed alert from a broken one: a run that
// deliberately stays quiet inside the suppression window must not report the
// alerting path as broken.
let dispatchResult = { attempted: false, dispatched: false, configured: config.alertChannels.length > 0, delivered: [], failed: [] };
if (dispatch) {
  dispatchResult = { attempted: true, ...(await dispatchAlert(buildAlertPayload(summary, now, config.storefrontOrigin))) };
} else if (config.alertChannels.length > 0 && summary.failed > 0) {
  // Only a real failure can be held back by the repeat window. A healthy run
  // also lands here (shouldDispatchAlert returns false when nothing failed and
  // no recovery is owed), and announcing "the failure is still recorded" on a
  // green run would be the log line inventing a failure - the same class of lie
  // as a check that pretends to pass.
  log('INFO', 'alert suppressed by the repeat window; the failure is still recorded');
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
const alertDeliveryFailed = dispatchResult.attempted && !dispatchResult.dispatched;
log('ERROR', `monitoring failed ${summary.failed}/${summary.total} checks: ${summary.failing.join(', ')}`);
process.exit(alertDeliveryFailed ? EXIT_CODES.alertDeliveryFailed : EXIT_CODES.checksFailed);
