#!/usr/bin/env bash
# Local end-to-end check of production alert delivery.
#
# Runs the REAL monitor against a REAL HTTPS receiver that answers exactly like
# Feishu, Slack and Telegram do, then asserts both the bytes on the wire and the
# delivered/failed verdict. No production host and no credentials are needed.
#
# What it proves: the provider dialect is correct, and a channel that answers
# HTTP 200 with an application error is reported as a failed delivery (exit 2)
# instead of a delivered alert.
# What it does NOT prove: that your own channel exists and accepts the message.
# That step still needs the real webhook and is recorded in docs/RUNBOOK.md §9.
#
# Requires: node 22+, openssl, network access to the public storefront (read-only).
# Usage: npm run test:alert-delivery   (or: bash tests/alert-delivery/run.sh)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR="${PAWSHOP_MONITOR_SCRIPT:-$DIR/../../scripts/monitor-production.mjs}"
NODE="${NODE:-node}"
PORT="${PAWSHOP_ALERT_TEST_PORT:-9443}"
WORK="$(mktemp -d)"
SINK_PID=""
PASS=0
FAIL=0

cleanup() {
  if [ -n "$SINK_PID" ]; then
    kill "$SINK_PID" 2>/dev/null || true
    wait "$SINK_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$WORK/sink.key" -out "$WORK/sink.crt" \
  -subj "/CN=open.feishu.cn" \
  -addext "subjectAltName=DNS:open.feishu.cn,DNS:open.larksuite.com,DNS:api.telegram.org,DNS:hooks.slack.com" \
  >/dev/null 2>&1

PAWSHOP_ALERT_TEST_DIR="$WORK" PAWSHOP_ALERT_TEST_PORT="$PORT" "$NODE" "$DIR/sink.mjs" >/dev/null 2>&1 &
SINK_PID=$!
sleep 1

# Deliberate, single-cause failure: the certificate age threshold can never be met,
# so exactly one check fails and an alert is always due. Everything else is read-only.
export PAWSHOP_MONITOR_STOREFRONT_ORIGIN=https://pawlivora.com
export PAWSHOP_MONITOR_COMMERCE_ORIGIN=http://127.0.0.1:9000
export PAWSHOP_MONITOR_SKIP_COMMERCE_CHECKS=1
export PAWSHOP_MONITOR_SKIP_SYSTEMD_CHECKS=1
export PAWSHOP_MONITOR_MIN_TLS_DAYS=99999
export PAWSHOP_MONITOR_LATENCY_BUDGET_MS=15000
export PAWSHOP_MONITOR_TELEGRAM_CHAT_ID=-1001234567890
export NODE_TLS_REJECT_UNAUTHORIZED=0

run_case() {
  local label="$1" provider="$2" url="$3" expected="$4" state="$5"
  export PAWSHOP_MONITOR_ALERT_PROVIDER="$provider"
  export PAWSHOP_MONITOR_ALERT_WEBHOOK="$url"
  export PAWSHOP_MONITOR_STATE_FILE="$WORK/state-$state.json"
  local output code verdict=PASS
  output="$("$NODE" --import "$DIR/dns-stub.mjs" "$MONITOR" 2>&1)" && code=0 || code=$?
  [ "$code" -eq "$expected" ] || verdict=FAIL
  echo "$output" | grep -qE 'TypeError|SyntaxError|unhandled' && verdict=FAIL
  printf -- '--- %-34s exit=%s expected=%s %s\n' "$label" "$code" "$expected" "$verdict"
  if [ "$verdict" = PASS ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
}

echo "=== alert delivery end-to-end ==="
rm -f "$WORK"/state-*.json
run_case "feishu accepted"        feishu   "https://open.feishu.cn:$PORT/feishu-ok"        1 feishu
run_case "feishu 200 + error code" feishu  "https://open.feishu.cn:$PORT/feishu-bad"       2 feishu-bad
run_case "feishu v1 StatusCode"    feishu  "https://open.feishu.cn:$PORT/feishu-ok-v1"     1 feishu-v1
run_case "slack accepted"          slack   "https://hooks.slack.com:$PORT/slack-ok"        1 slack
run_case "slack 400"               slack   "https://hooks.slack.com:$PORT/slack-400"       2 slack-bad
run_case "telegram ok=false"       telegram "https://api.telegram.org:$PORT/telegram-bad"  2 telegram-bad
run_case "generic 500"             generic "https://hooks.slack.com:$PORT/generic-500"     2 generic-bad
run_case "suppression: first"      feishu  "https://open.feishu.cn:$PORT/feishu-ok"        1 suppress
run_case "suppression: second"     feishu  "https://open.feishu.cn:$PORT/feishu-ok"        1 suppress

# A declared channel with no endpoint must refuse to run rather than monitor silently.
export PAWSHOP_MONITOR_ALERT_PROVIDER=telegram
export PAWSHOP_MONITOR_ALERT_WEBHOOK="https://api.telegram.org:$PORT/telegram-ok"
unset PAWSHOP_MONITOR_TELEGRAM_CHAT_ID
if PAWSHOP_MONITOR_STATE_FILE="$WORK/state-nochat.json" "$NODE" --import "$DIR/dns-stub.mjs" "$MONITOR" >/dev/null 2>&1; then
  printf -- '--- %-34s %s\n' "telegram without chat id" FAIL
  FAIL=$((FAIL + 1))
else
  printf -- '--- %-34s %s\n' "telegram without chat id" PASS
  PASS=$((PASS + 1))
fi

echo
echo "=== payloads received on the wire ==="
"$NODE" -e '
const { readFileSync } = require("node:fs");
const lines = readFileSync(process.argv[1], "utf8").trim().split("\n");
for (const line of lines) {
  const entry = JSON.parse(line);
  const body = typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body);
  console.log(`${entry.path}  [${entry.contentType}]`);
  console.log(`  ${body.slice(0, 200)}`);
}
console.log(`deliveries received: ${lines.length}`);
' "$WORK/requests.log"

echo
echo "=== PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
