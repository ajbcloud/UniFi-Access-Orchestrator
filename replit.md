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
- **WebSocket event filtering**: Only access-relevant event types are passed through (`access.logs.add`, `access.door.unlock`, `access.doorbell.*`, etc.). Device telemetry (`data.device.update`, `data.v2.device.update`, heartbeats) is silently dropped at the WebSocket handler level. A safety filter in `normalizeEvent()` also rejects any `data.*` types as a second layer. Filter stats (passed/filtered counts) are shown in the dashboard System Info section and in the `/health` endpoint under `unifi.ws_events_passed`, `unifi.ws_events_filtered`, `unifi.ws_last_filtered_type`. Stats persist across WebSocket reconnects.
- **`patchEngineForBroadcast(engine)`** helper in `src/index.js` consolidates the event handler monkey-patching for SSE broadcast. Called on initial setup and after reload/config-save re-instantiation.

## Config Backup System

- **Module**: `src/backup.js` — `createBackup()`, `listBackups()`, `restoreBackup()`, `pruneBackups()`
- **Auto-backup on save**: Every `PUT /api/config` creates a backup before applying changes
- **Scheduled backup**: Daily check, creates backup if last one is older than `backup.interval_days` (default 30)
- **Pre-restore safety**: Restoring always creates a backup of the current config first
- **Config keys**: `backup.interval_days` (default 30), `backup.max_backups` (default 12)
- **Backup directory**: `BACKUP_DIR` env var, or `backups/` subdirectory next to `config.json`
- **API endpoints**: `GET /api/backups`, `POST /api/backups`, `POST /api/backups/restore`, `GET /api/backups/:filename`
- **UI**: "Backup & Restore" card in Settings tab with create/restore/download actions
- **Electron**: `electron/main.js` sets `BACKUP_DIR` to `userData/backups/`, creates directory on startup, adds "Backup Config Now" and "Open Backups Folder" menu items

## Notes

- The setup wizard shows on first run when no controller is configured. Users can skip it and configure later from the Settings tab.
- The server starts listening immediately; UniFi client initialization happens in the background so the dashboard is always accessible.
- The `unifi-access-app/` subdirectory and `unifi-access-orchestrator-app.tar.gz` are source archives bundled with the repo.
