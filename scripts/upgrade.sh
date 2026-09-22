#!/usr/bin/env bash
# ============================================================
# UniFi Access Orchestrator - headless self-upgrade
# ============================================================
# Replaces the installed application files with a tagged GitHub release,
# reinstalls dependencies, and restarts the systemd service. Used by:
#
#   - the upgrade helper (unifi-access-orchestrator-upgrade.service, root),
#     which runs it when the dashboard's Upgrade button drops
#     $STATE_DIR/upgrade.request;
#   - the service itself in "direct" mode when its own directory is writable
#     (no systemd sandbox), with SERVICE="" so it exits and lets whatever
#     supervises it restart the new version;
#   - a person at a shell:  sudo bash scripts/upgrade.sh latest
#
# Usage: upgrade.sh [vX.Y.Z | latest]
#   With no argument the version comes from $STATE_DIR/upgrade.request, or
#   "latest" if there is no request file.
#
# Environment (all optional):
#   APP_DIR    install directory           (default /opt/unifi-access-orchestrator)
#   APP_USER   owner to chown back to      (default middleware; "" keeps ownership)
#   SERVICE    systemd unit to restart     (default unifi-access-orchestrator; "" skips)
#   STATE_DIR  request/result directory    (default /var/lib/unifi-access-orchestrator)
#   REPO       GitHub owner/name           (default ajbcloud/UniFi-Access-Orchestrator)
#
# The dashboard reads $STATE_DIR/upgrade.result for progress and outcome:
#   {"status":"running","step":"...","version":"vX.Y.Z","started_at":"..."}
#   {"status":"ok","version":"vX.Y.Z","previous_version":"vA.B.C","finished_at":"..."}
#   {"status":"failed","version":"vX.Y.Z","error":"...","finished_at":"..."}
#
# config/config.json, backups, logs and the Z-Wave key store are never touched.
# ============================================================

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/unifi-access-orchestrator}"
APP_USER="${APP_USER-middleware}"
SERVICE="${SERVICE-unifi-access-orchestrator}"
STATE_DIR="${STATE_DIR:-/var/lib/unifi-access-orchestrator}"
REPO="${REPO:-ajbcloud/UniFi-Access-Orchestrator}"
HELPER_SCRIPT_DIR="/usr/local/lib/unifi-access-orchestrator"

REQUEST_FILE="$STATE_DIR/upgrade.request"
RESULT_FILE="$STATE_DIR/upgrade.result"
ROLLBACK_DIR="$STATE_DIR/rollback"

# Files and directories that make up a release. config/ is handled separately
# so config.json survives; node_modules is rebuilt by npm.
PAYLOAD=(src public electron assets scripts package.json package-lock.json LICENSE README.md)

WORK=""
PREV_VERSION=""
TARGET=""
STEP=""

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[upgrade] $*"; }

json_escape() {
  # Minimal JSON string escaping for messages we write ourselves.
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/ }"; s="${s//$'\r'/}"; s="${s//$'\t'/ }"
  printf '%s' "$s"
}

write_result() {
  # write_result <status> [error]
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  local status="$1" err="${2:-}"
  local tmp="$RESULT_FILE.tmp"
  {
    printf '{"status":"%s","version":"%s","previous_version":"%s","step":"%s"' \
      "$status" "$(json_escape "$TARGET")" "$(json_escape "$PREV_VERSION")" "$(json_escape "$STEP")"
    if [ -n "$err" ]; then printf ',"error":"%s"' "$(json_escape "$err")"; fi
    if [ "$status" = "running" ]; then printf ',"started_at":"%s"' "${STARTED_AT:-$(now)}"; else printf ',"finished_at":"%s"' "$(now)"; fi
    printf '}\n'
  } > "$tmp" 2>/dev/null && mv -f "$tmp" "$RESULT_FILE" 2>/dev/null || true
  if [ -n "$APP_USER" ] && id "$APP_USER" &>/dev/null; then chown "$APP_USER":"$APP_USER" "$RESULT_FILE" 2>/dev/null || true; fi
}

step() { STEP="$1"; log "$1"; write_result running; }

fail() {
  local msg="$1"
  log "ERROR: $msg"
  if [ -d "$ROLLBACK_DIR" ] && [ -f "$ROLLBACK_DIR/.complete" ]; then
    log "Rolling back to the previous files..."
    for item in "${PAYLOAD[@]}"; do
      if [ -e "$ROLLBACK_DIR/$item" ]; then
        rm -rf "$APP_DIR/$item"
        cp -a "$ROLLBACK_DIR/$item" "$APP_DIR/$item"
      fi
    done
    fix_owner
    log "Rollback done. The previous version is back in place."
  fi
  write_result failed "$msg"
  restart_service || true
  cleanup
  exit 1
}

cleanup() { [ -n "$WORK" ] && rm -rf "$WORK" 2>/dev/null || true; }

fix_owner() {
  if [ -n "$APP_USER" ] && [ "$(id -u)" = "0" ] && id "$APP_USER" &>/dev/null; then
    chown -R "$APP_USER":"$APP_USER" "$APP_DIR" 2>/dev/null || true
  fi
}

restart_service() {
  [ -z "$SERVICE" ] && return 0
  [ "${UPGRADE_NO_RESTART:-0}" = "1" ] && return 0
  if command -v systemctl &>/dev/null; then
    log "Restarting $SERVICE..."
    systemctl restart "$SERVICE" || return 1
  fi
}

fetch() {
  # fetch <url> <outfile>
  if command -v curl &>/dev/null; then
    curl -fsSL --retry 3 --retry-delay 2 -A "unifi-access-orchestrator-upgrade" -o "$2" "$1"
  elif command -v wget &>/dev/null; then
    wget -q --tries=3 -U "unifi-access-orchestrator-upgrade" -O "$2" "$1"
  else
    return 127
  fi
}

resolve_latest() {
  local tmp="$WORK/latest.json"
  fetch "https://api.github.com/repos/$REPO/releases/latest" "$tmp" || return 1
  # tag_name is the first "tag_name" key; no jq dependency on a Pi.
  sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp" | head -n1
}

# ------------------------------------------------------------
trap cleanup EXIT

if [ ! -d "$APP_DIR" ] || [ ! -f "$APP_DIR/package.json" ]; then
  echo "ERROR: $APP_DIR does not look like an install (no package.json)." >&2
  exit 2
fi

WORK="$(mktemp -d /tmp/uao-upgrade.XXXXXX)"
STARTED_AT="$(now)"

# Version: argument, else the request file, else latest.
REQUESTED="${1:-}"
if [ -z "$REQUESTED" ] && [ -f "$REQUEST_FILE" ]; then
  REQUESTED="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REQUEST_FILE" | head -n1)"
fi
# Consume the request first so the path unit does not retrigger in a loop.
rm -f "$REQUEST_FILE" 2>/dev/null || true
REQUESTED="${REQUESTED:-latest}"

PREV_VERSION="v$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -n1)"
TARGET="$REQUESTED"
step "Resolving release"

if [ "$REQUESTED" = "latest" ]; then
  TARGET="$(resolve_latest || true)"
  [ -n "$TARGET" ] || fail "Could not look up the latest release on GitHub (network or rate limit)."
fi
case "$TARGET" in v*) ;; *) TARGET="v$TARGET" ;; esac
if ! printf '%s' "${TARGET#v}" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  fail "Invalid release version: $TARGET"
fi
log "Upgrading $APP_DIR from $PREV_VERSION to $TARGET"

command -v npm &>/dev/null || fail "npm is not installed or not on PATH for this user."
command -v node &>/dev/null || fail "node is not installed or not on PATH for this user."

# ------------------------------------------------------------
step "Downloading $TARGET"
TARBALL="$WORK/release.tar.gz"
fetch "https://github.com/$REPO/archive/refs/tags/$TARGET.tar.gz" "$TARBALL" \
  || fail "Download of $TARGET failed. Does that release exist?"
mkdir -p "$WORK/src"
tar -xzf "$TARBALL" -C "$WORK/src" || fail "The downloaded archive could not be extracted."
SRC="$(find "$WORK/src" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[ -n "$SRC" ] && [ -f "$SRC/package.json" ] || fail "The archive did not contain a package.json."

# ------------------------------------------------------------
step "Backing up current files"
rm -rf "$ROLLBACK_DIR"; mkdir -p "$ROLLBACK_DIR"
for item in "${PAYLOAD[@]}"; do
  [ -e "$APP_DIR/$item" ] && cp -a "$APP_DIR/$item" "$ROLLBACK_DIR/$item"
done
touch "$ROLLBACK_DIR/.complete"

# ------------------------------------------------------------
step "Installing files"
for item in "${PAYLOAD[@]}"; do
  if [ -e "$SRC/$item" ]; then
    rm -rf "$APP_DIR/$item"
    cp -a "$SRC/$item" "$APP_DIR/$item"
  fi
done
# Example configs travel with the release; the live config.json never moves.
mkdir -p "$APP_DIR/config"
for ex in "$SRC"/config/*.example.json; do
  [ -f "$ex" ] && cp -a "$ex" "$APP_DIR/config/"
done

# The release workflow stamps package.json at build time (the tag is the
# source of truth), so a source archive still carries the version on main.
# Stamp it here the same way so the app reports the release it really is.
(cd "$APP_DIR" && npm version "${TARGET#v}" --no-git-tag-version --allow-same-version >/dev/null) \
  || fail "Could not stamp package.json with ${TARGET#v}."

# ------------------------------------------------------------
step "Installing dependencies (this takes a few minutes on a Pi)"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export npm_config_loglevel=error
if [ -f "$APP_DIR/package-lock.json" ]; then
  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund) \
    || (cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund) \
    || fail "npm install failed. See the output above."
else
  (cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund) || fail "npm install failed. See the output above."
fi
fix_owner

# ------------------------------------------------------------
step "Verifying"
# Version-agnostic: the entry point parses and the runtime dependency resolves.
(cd "$APP_DIR" && test -f src/index.js && node --check src/index.js && node -e "require('express'); require('./package.json')") \
  || fail "The upgraded files do not load. Rolled back."

# Keep the helper's private copy of this script current for the NEXT run
# (install to a temp name and rename: bash holds the old inode open).
if [ "$(id -u)" = "0" ] && [ -d "$HELPER_SCRIPT_DIR" ] && [ -f "$APP_DIR/scripts/upgrade.sh" ]; then
  install -m 0755 "$APP_DIR/scripts/upgrade.sh" "$HELPER_SCRIPT_DIR/upgrade.sh.new" \
    && mv -f "$HELPER_SCRIPT_DIR/upgrade.sh.new" "$HELPER_SCRIPT_DIR/upgrade.sh" || true
fi

rm -rf "$ROLLBACK_DIR"
STEP="done"
write_result ok
log "Upgraded to $TARGET (was $PREV_VERSION)."
restart_service || log "WARNING: could not restart $SERVICE; restart it by hand."
exit 0
