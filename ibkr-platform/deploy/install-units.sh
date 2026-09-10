#!/usr/bin/env bash
# Install this platform's systemd units.
#
#   sudo deploy/install-units.sh [/path/to/ibkr-platform]
#
# Installs ibkr-api, ibkr-web, ibkr-worker, and the templated
# ibkr-gateway@.service that runs one IB Gateway per broker connection.
#
# It deliberately does NOT install or touch ibkr-gateway.service. On a host that
# already runs one, that unit and its /opt/ibc/config.ini are adopted as they
# are (see docs/migration-runbook.md); on a new host, gateways are provisioned
# per connection through the templated unit instead.
#
# Nothing is started. Starting a live gateway performs a real IBKR login.
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
UNITS=/etc/systemd/system

if [[ ! -d "$ROOT/backend" || ! -d "$ROOT/frontend" ]]; then
  echo "Not a platform root: $ROOT" >&2
  exit 1
fi

for unit in ibkr-api ibkr-web ibkr-worker; do
  sed "s|__PLATFORM_ROOT__|$ROOT|g" "$(dirname "$0")/$unit.service" > "$UNITS/$unit.service"
  echo "Installed $UNITS/$unit.service"
done

"$(dirname "$0")/install-gateway-template.sh" "$ROOT/backend"

systemctl daemon-reload
echo
echo "Enable them when you are ready:"
echo "  systemctl enable --now ibkr-api ibkr-web ibkr-worker"
