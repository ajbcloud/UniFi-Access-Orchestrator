#!/bin/bash
# ============================================================
# UniFi Access Orchestrator - Raspberry Pi Setup Script
# ============================================================
# Run this on a fresh Raspberry Pi OS Lite installation.
# Usage: sudo bash setup-pi.sh
# ============================================================

set -e

APP_DIR="/opt/unifi-access-orchestrator"
APP_USER="middleware"
LOG_DIR="/var/log/unifi-access-orchestrator"
NODE_VERSION="20"

echo "============================================"
echo " UniFi Access Orchestrator - Pi Setup"
echo "============================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "ERROR: Please run as root (sudo bash setup-pi.sh)"
  exit 1
fi

# ---------------------------------------------------------------
# 1. System updates
# ---------------------------------------------------------------
echo "[1/7] Updating system packages..."
apt-get update -y
apt-get upgrade -y

# ---------------------------------------------------------------
# 2. Install Node.js
# ---------------------------------------------------------------
echo "[2/7] Installing Node.js ${NODE_VERSION}..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y nodejs
else
  echo "  Node.js already installed: $(node --version)"
fi

echo "  Node: $(node --version)"
echo "  npm:  $(npm --version)"

# ---------------------------------------------------------------
# 3. Create application user
# ---------------------------------------------------------------
echo "[3/7] Creating application user..."
if ! id "$APP_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /bin/false "$APP_USER"
  echo "  Created user: $APP_USER"
else
  echo "  User already exists: $APP_USER"
fi

# ---------------------------------------------------------------
# 4. Deploy application
# ---------------------------------------------------------------
echo "[4/7] Deploying application to ${APP_DIR}..."
mkdir -p "$APP_DIR"
mkdir -p "$LOG_DIR"

# Copy application files (assumes this script is run from the project root)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/../package.json" ]; then
  cp -r "${SCRIPT_DIR}/../package.json" "$APP_DIR/"
  cp -r "${SCRIPT_DIR}/../src" "$APP_DIR/"
  mkdir -p "$APP_DIR/config"

  # Only copy config if it doesn't already exist (preserve existing config)
  if [ ! -f "$APP_DIR/config/config.json" ]; then
    cp "${SCRIPT_DIR}/../config/config.json" "$APP_DIR/config/"
    echo "  Config copied (you still need to edit it with your API token and door IDs)"
  else
    echo "  Config already exists, not overwriting"
  fi
else
  echo "  WARNING: Run this script from the project directory"
  echo "  Files will need to be copied manually to ${APP_DIR}"
fi

# Install dependencies
cd "$APP_DIR"
npm install --production
echo "  Dependencies installed"

# Set ownership
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$LOG_DIR"

# ---------------------------------------------------------------
# 5. Create systemd service
# ---------------------------------------------------------------
echo "[5/7] Creating systemd service..."
cat > /etc/systemd/system/unifi-access-orchestrator.service << 'EOF'
[Unit]
Description=UniFi Access Orchestrator
Documentation=https://github.com/ajbcloud/UniFi-Access-Orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=middleware
Group=middleware
WorkingDirectory=/opt/unifi-access-orchestrator
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

# Environment
Environment=NODE_ENV=production
Environment=CONFIG_PATH=/opt/unifi-access-orchestrator/config/config.json

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=unifi-access-orchestrator

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/log/unifi-access-orchestrator
ReadOnlyPaths=/opt/unifi-access-orchestrator

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
echo "  Service created: unifi-access-orchestrator.service"

# ---------------------------------------------------------------
# 6. Configure firewall (if ufw is active)
# ---------------------------------------------------------------
echo "[6/7] Configuring firewall..."
if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
  ufw allow 3000/tcp comment "Access Orchestrator webhook"
  echo "  Port 3000 opened in UFW"
else
  echo "  UFW not active, skipping (port 3000 should be accessible on LAN)"
fi

# ---------------------------------------------------------------
# 7. Set static IP (optional, prints instructions)
# ---------------------------------------------------------------
echo "[7/7] Network configuration..."
echo ""
echo "  IMPORTANT: The Pi should have a static IP so the Alarm Manager"
echo "  webhook URL does not change. You can set this in:"
echo "    /etc/dhcpcd.conf"
echo "  Or assign a DHCP reservation on the router/switch for this Pi's MAC."
echo ""
CURRENT_IP=$(hostname -I | awk '{print $1}')
echo "  Current IP: ${CURRENT_IP}"
echo ""

# ---------------------------------------------------------------
# Done
# ---------------------------------------------------------------
echo "============================================"
echo " Setup Complete"
echo "============================================"
echo ""
echo " Next steps:"
echo ""
echo " 1. Edit the config file:"
echo "    sudo nano ${APP_DIR}/config/config.json"
echo "    - Set unifi.host to your CloudKey IP"
echo "    - Set unifi.token to your API token"
echo "    - Door IDs will be auto-discovered on startup"
echo ""
echo " 2. Run the validation tool:"
echo "    cd ${APP_DIR} && sudo -u ${APP_USER} node src/validate.js"
echo ""
echo " 3. Start the service:"
echo "    sudo systemctl start unifi-access-orchestrator"
echo "    sudo systemctl enable unifi-access-orchestrator"
echo ""
echo " 4. Check status:"
echo "    sudo systemctl status unifi-access-orchestrator"
echo "    sudo journalctl -u unifi-access-orchestrator -f"
echo ""
echo " 5. Health check:"
echo "    curl http://${CURRENT_IP}:3000/health"
echo ""
echo " 6. Configure Alarm Manager in UniFi Access:"
echo "    Webhook URL: http://${CURRENT_IP}:3000/webhook"
echo ""
echo "============================================"
