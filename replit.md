# UniFi Access Orchestrator

Multi-door unlock automation for UniFi Access with a built-in admin dashboard.

## Overview

This is a headless Node.js/Express service that integrates with Ubiquiti UniFi Access to automate door unlock sequences based on configurable rules. When someone badges in at a trigger door, it automatically unlocks additional doors based on their user group. It also handles intercom/doorbell events.

## Architecture

- **Runtime**: Node.js 20
- **Framework**: Express 4
- **Real-time**: Server-Sent Events (SSE) for live dashboard updates
- **Dashboard**: Single-page HTML (`public/index.html`) served statically
- **Logging**: Winston with daily rotation to `./logs/`

## Key Files

- `src/index.js` — Express server, all API routes, SSE event broadcasting. Server starts listening before UniFi client initialization so the dashboard is available immediately.
- `src/unifi-client.js` — UniFi Access API client (doors, users, webhooks, WebSocket)
- `src/resolver.js` — Resolves user IDs to group names
- `src/rules-engine.js` — Processes access events and decides which doors to unlock
- `src/logger.js` — Winston logger with daily file rotation (logs to `./logs/` directory)
- `src/validate.js` — CLI connectivity validation tool
- `public/index.html` — Admin dashboard UI (single-file SPA, no build step). Contains all CSS, HTML, and JS for: setup wizard, dashboard, live events, configuration (rule builder), settings, and test tools.
- `config/config.json` — Runtime configuration (not committed)
- `config/config.example.json` — Configuration template

## Dashboard Tabs

- **Dashboard** — Stats overview (doors, users, events, unlocks)
- **Live Events** — Real-time SSE event feed
- **Configuration** — Rule builder UI with:
  - Door Mappings (auto-discovered from controller)
  - User Groups (with logical name mapping)
  - Access Rules (NFC/PIN/Face/Mobile) — natural language rule cards with add/edit/delete
  - Visitor Rules (Doorbell/Buzz-in) — can link to access rules or use custom doors, plus viewer device mappings
  - Event Source configuration
- **Settings** — Server port, controller connection, logging level
- **Test Tools** — Test Configured Rules (simulate access/visitor rules with one click), door unlock testing, custom event simulation, connectivity test, raw event payload viewer

## Configuration

The app reads from `config/config.json` at startup. Key settings:
- `server.port`: Set to **5000** for Replit webview
- `server.host`: Set to `0.0.0.0`
- `unifi.host`: IP of the UniFi Access controller (local network)
- `unifi.token`: UniFi Access API token
- `unifi.port`: Default `12445`

### Rule Format (array-based, per-rule trigger doors)

Both `unlock_rules` and `doorbell_rules` use an array-based `rules` format where each rule specifies its own trigger door. This supports multiple rules per group with different trigger locations:

```json
"unlock_rules": {
  "rules": [
    { "group": "GroupA", "trigger": "Front Door", "unlock": ["Lobby", "Elevator"] },
    { "group": "GroupA", "trigger": "Side Door", "unlock": ["Stairwell"] },
    { "group": "GroupB", "trigger": "Front Door", "unlock": ["Suite 200"] }
  ],
  "default_action": { "unlock": [] }
}
```

Backward compatibility: the rules engine and frontend both handle the legacy format (`trigger_location` + `group_actions` object) by normalizing to the array format on read.

## Workflow

- **Start application**: `node src/index.js` on port 5000 (webview)

## Deployment

Configured as a **VM** deployment target (uses in-memory state + SSE/WebSocket connections).
Run command: `node src/index.js`

## Diagnostics & Debugging

- **Processing diagnostics**: `stats.last_processing` tracks detailed info after each event (action, actorId, resolvedGroup, resolveStrategy, doors attempted/unlocked, etc.). SSE broadcasts include descriptive action text showing exactly what happened at each processing step.
- **Raw payload viewer**: Last 30 incoming payloads (webhook + WebSocket) stored in a ring buffer, accessible via `GET /api/debug/payloads` and viewable in the Test Tools tab.
- **WebSocket status**: Dashboard System Info section shows a live connected/disconnected indicator when event source mode is `websocket`.
- **Event noise filtering** (two layers): (1) WebSocket whitelist in `unifi-client.js` only passes access-relevant types (`access.logs.add`, `access.door.unlock`, `access.doorbell.*`, etc.) and drops device telemetry. (2) `normalizeEvent()` in `rules-engine.js` rejects any `data.*` / `data.v2.*` types and returns `false`, which causes `handleEvent` to return `false`. The broadcast wrapper (`patchEngineForBroadcast`) checks this return value and skips SSE broadcast entirely for filtered events — preventing stale data from appearing in the Live Events feed. Filter stats: `engine.events_filtered` in `/health`, plus `unifi.ws_events_passed/ws_events_filtered` for WebSocket-specific counts. Dashboard System Info shows combined filter count.
- **`patchEngineForBroadcast(engine)`** helper in `src/index.js` consolidates the event handler monkey-patching for SSE broadcast. Skips broadcast when `handleEvent` returns `false` (filtered event). Called on initial setup and after reload/config-save re-instantiation.

## Resilience & Auto-Recovery (v4.2.0)

- **`initializeWithRetry()`**: Exponential backoff (5s→10s→20s→40s→60s cap), infinite retry. Used when initial `initialize()` fails.
- **`startHealthMonitor()`**: 30s probe via GET /doors. Detects connectivity loss, auto re-discovers doors and re-syncs users on recovery. Tracks `connectionState` (connected/disconnected/reconnecting/connecting).
- **WebSocket ping/pong heartbeat**: 30s ping interval, terminates stale half-open TCP connections that don't respond.
- **Unlock retry**: `executeUnlocks()` tries each door sequentially with 3 attempts and 2s delay between retries. Skips retries on 401/403 auth errors.
- **Event activity watchdog**: Exits process (for external restart) if no events received for `watchdog.inactivity_timeout_minutes` (default 60, configurable, 0 disables).
- **Startup flow**: Fast first try with `initialize()`, falls back to background `initializeWithRetry()` + health monitor. Server always starts immediately.
- **Electron watchdog**: 30s health poll, 3 consecutive failures trigger `app.relaunch()`. Updates window title with connection state.
- **Dashboard enhancements**: Connection state pill in System Info + header, last event age display, date+time in Live Events feed ("Mar 31 7:21:36 PM" format).

## Config Backup System

- **Module**: `src/backup.js` — `createBackup()`, `listBackups()`, `restoreBackup()`, `pruneBackups()`
- **Scheduled backup**: Daily check, creates backup if last one is older than `backup.interval_days` (default 30)
- **Manual backup**: Dashboard button or Electron menu "Backup Config Now"
- **Pre-restore safety**: Restoring always creates a backup of the current config first
- **Config keys**: `backup.interval_days` (default 30), `backup.max_backups` (default 12)
- **Backup directory**: `BACKUP_DIR` env var, or `backups/` subdirectory next to `config.json`
- **API endpoints**: `GET /api/backups`, `POST /api/backups`, `POST /api/backups/restore`, `GET /api/backups/:filename`
- **UI**: "Backup & Restore" card in Settings tab with create/restore/download actions
- **Electron**: `electron/main.js` sets `BACKUP_DIR` to `userData/backups/`, creates directory on startup, adds "Backup Config Now" and "Open Backups Folder" menu items

## CI/CD — GitHub Actions

- **Workflow**: `.github/workflows/release.yml` — "Build & Release"
- **Triggers**: Tag push (`v*`) and manual `workflow_dispatch` with optional version input + bump type selector (patch/minor/major)
- **Version bump**: On dispatch, auto-bumps `package.json`, commits, tags, and pushes before building. Validates semver format and checks for existing tags.
- **Build matrix**: Windows (.exe), Linux x64 (.deb + .AppImage), Linux ARM/Raspberry Pi (.deb), macOS (.dmg)
- **Release**: Creates GitHub Release with all artifacts and auto-generated release notes
- **Version display**: `/health` endpoint exposes `version` from `package.json`; dashboard System Info card shows it as a badge (e.g. "v4.2.0")

## Notes

- The setup wizard shows on first run when no controller is configured. Users can skip it and configure later from the Settings tab.
- The server starts listening immediately; UniFi client initialization happens in the background so the dashboard is always accessible.
- The `unifi-access-app/` subdirectory and `unifi-access-orchestrator-app.tar.gz` are source archives bundled with the repo.
