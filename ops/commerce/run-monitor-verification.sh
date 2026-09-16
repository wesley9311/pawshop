#!/usr/bin/env bash
# Run the production monitor exactly the way pawshop-monitor.service does, with an
# optional override environment file layered on top.
#
# Why this exists: alerting the owner for real is the only way to prove a channel
# works, and a deliberate failure is the only way to make an alert fire on demand.
# Both need an extra environment variable — but a webhook URL is a write
# credential, and a command line is visible in `ps` and lands in shell history.
# So the overrides live in a root-only file that is sourced here, and the URL
# never appears as an argument.
#
# Usage (root, on the production host):
#   install -o root -g root -m 0600 pawshop-verify.env /root/
#   /root/run-monitor-verification.sh /root/pawshop-verify.env
#
# The caller is responsible for deleting the override file afterwards.
set -euo pipefail

ENVIRONMENT_FILE=${PAWSHOP_MONITOR_ENV_FILE:-/etc/pawshop-monitor/monitoring.env}
MONITOR=/usr/local/libexec/pawshop/monitor-production.mjs
OVERRIDE=${1:-}

[[ -r $ENVIRONMENT_FILE ]] || { echo "cannot read $ENVIRONMENT_FILE" >&2; exit 1; }
[[ -r $MONITOR ]] || { echo "cannot read $MONITOR" >&2; exit 1; }

# set -a exports everything the files define, which is how systemd's
# EnvironmentFile behaves too: the monitor sees the same values.
set -a
# shellcheck disable=SC1090
. "$ENVIRONMENT_FILE"
if [[ -n $OVERRIDE ]]; then
  [[ -r $OVERRIDE ]] || { echo "cannot read override $OVERRIDE" >&2; exit 1; }
  # shellcheck disable=SC1090
  . "$OVERRIDE"
fi
set +a

# Same identity as the unit (User=pawshop Group=pawshop), no capabilities, and no
# environment preserved from the caller beyond what was just sourced.
exec /usr/bin/setpriv \
  --reuid=pawshop --regid=pawshop --init-groups \
  --inh-caps=-all --no-new-privs \
  /usr/bin/node "$MONITOR"
