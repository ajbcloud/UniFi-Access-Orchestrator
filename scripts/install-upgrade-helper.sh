#!/usr/bin/env bash
# ============================================================
# UniFi Access Orchestrator - install the headless upgrade helper
# ============================================================
# The service runs unprivileged inside a systemd sandbox that mounts its own
# install directory read-only, so it cannot replace its files. This helper
# gives the dashboard's Upgrade button a safe way to do it:
#
#   1. The service drops  /var/lib/unifi-access-orchestrator/upgrade.request
#   2. unifi-access-orchestrator-upgrade.path (root) notices the file
#   3. unifi-access-orchestrator-upgrade.service runs upgrade.sh as root,
#      which downloads the release, swaps the files, reinstalls dependencies
#      and restarts the main service.
#
# Idempotent: safe to run again after any upgrade. setup-pi.sh runs it for
# new installs; existing installs run it once by hand:
#
#   sudo bash /opt/unifi-access-orchestrator/scripts/install-upgrade-helper.sh
# ============================================================

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/unifi-access-orchestrator}"
APP_USER="${APP_USER:-middleware}"
SERVICE="${SERVICE:-unifi-access-orchestrator}"
STATE_DIR="${STATE_DIR:-/var/lib/unifi-access-orchestrator}"
HELPER_SCRIPT_DIR="/usr/local/lib/unifi-access-orchestrator"

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: run as root (sudo bash install-upgrade-helper.sh)" >&2
  exit 1
fi
if ! command -v systemctl &>/dev/null; then
  echo "ERROR: systemd is required for the upgrade helper." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_SCRIPT="$APP_DIR/scripts/upgrade.sh"
[ -f "$SRC_SCRIPT" ] || SRC_SCRIPT="$SCRIPT_DIR/upgrade.sh"
[ -f "$SRC_SCRIPT" ] || { echo "ERROR: upgrade.sh not found next to this script or in $APP_DIR/scripts" >&2; exit 1; }

if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
  echo "Installing curl (needed to download releases)..."
  apt-get install -y curl >/dev/null 2>&1 || echo "  WARNING: could not install curl; install curl or wget by hand."
fi

echo "[1/4] Installing the upgrade script to $HELPER_SCRIPT_DIR"
# A private copy: the upgrade replaces $APP_DIR/scripts while it runs, and bash
# must never have its own script swapped out underneath it.
mkdir -p "$HELPER_SCRIPT_DIR"
install -m 0755 "$SRC_SCRIPT" "$HELPER_SCRIPT_DIR/upgrade.sh"

echo "[2/4] Creating the state directory $STATE_DIR"
mkdir -p "$STATE_DIR"
if id "$APP_USER" &>/dev/null; then chown "$APP_USER":"$APP_USER" "$STATE_DIR"; fi
chmod 0755 "$STATE_DIR"

echo "[3/4] Writing systemd units"
# Drop-in for the main service: a writable state dir (systemd exports its path
# as STATE_DIRECTORY) and the flag the app checks before offering Upgrade.
mkdir -p "/etc/systemd/system/$SERVICE.service.d"
cat > "/etc/systemd/system/$SERVICE.service.d/upgrade-helper.conf" <<EOF
# Added by install-upgrade-helper.sh: lets the dashboard's Upgrade button hand
# an upgrade request to the root helper unit through the state directory.
[Service]
StateDirectory=$(basename "$STATE_DIR")
Environment=UPDATE_STATE_DIR=$STATE_DIR
Environment=UPDATE_HELPER_INSTALLED=1
EOF

cat > "/etc/systemd/system/$SERVICE-upgrade.path" <<EOF
[Unit]
Description=Watch for UniFi Access Orchestrator upgrade requests
Documentation=https://github.com/ajbcloud/UniFi-Access-Orchestrator

[Path]
PathExists=$STATE_DIR/upgrade.request
Unit=$SERVICE-upgrade.service

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/$SERVICE-upgrade.service" <<EOF
[Unit]
Description=UniFi Access Orchestrator self-upgrade (runs when the dashboard requests it)
Documentation=https://github.com/ajbcloud/UniFi-Access-Orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR
Environment=APP_USER=$APP_USER
Environment=SERVICE=$SERVICE
Environment=STATE_DIR=$STATE_DIR
Environment=HOME=/root
ExecStart=/bin/bash $HELPER_SCRIPT_DIR/upgrade.sh
TimeoutStartSec=45min
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE-upgrade
EOF

echo "[4/4] Enabling the watcher"
systemctl daemon-reload
systemctl enable --now "$SERVICE-upgrade.path"

# The main service needs a restart to pick up the drop-in (state dir + flag).
if systemctl is-active --quiet "$SERVICE"; then
  echo "Restarting $SERVICE so it sees the helper..."
  systemctl restart "$SERVICE"
fi

echo ""
echo "Upgrade helper installed."
echo "  Watcher:  systemctl status $SERVICE-upgrade.path"
echo "  Logs:     journalctl -u $SERVICE-upgrade -f"
echo "  Manual:   sudo bash $HELPER_SCRIPT_DIR/upgrade.sh latest"
echo "The dashboard's Upgrade button now installs new releases in place."
