# UniFi Access Orchestrator

Multi-door unlock automation for UniFi Access with a built-in admin dashboard.

## Overview

This is a Node.js/Express service that integrates with Ubiquiti UniFi Access to automate door unlock sequences based on configurable rules. When someone badges in at a trigger door, it automatically unlocks additional doors based on their user group. It also handles intercom/doorbell events. It ships both headless and packaged as an Electron desktop app (Windows/macOS/Linux) with a system-tray runtime and a guided first-run setup wizard. An optional Smart Deadbolt (Z-Wave) add-on lets it drive a physical deadbolt, paired and managed entirely from the dashboard.

## Architecture

- **Runtime**: Node.js 22 (also packaged as an Electron 43 desktop app)
- **Event source**: WebSocket to the controller by default (no controller-side setup); Alarm Manager / API webhooks optional
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
- **Automations**: the door flow is the one configuration surface:
  - Door Mappings (auto-discovered from controller)
  - User Groups (with logical name mapping)
  - Door Flows: one card per door. Each card holds triggers (entry or doorbell), each with a scope (everyone, any group, or named groups) and actions (retract a deadbolt with a per edge after-unlock behavior, unlock other doors with debounce and delay). The group scope selector appears only when the site has groups.
  - Deadbolt Devices (Z-Wave): hardware only. Serial-port selection, in-app S2 pairing/unpairing, test, health. After-unlock behavior lives on the door card, not here.
- **Visual Designer**: the door flows as a read-only node graph (SVG edges + DOM nodes, pan/zoom); every detail panel deep-links to the door card, the single editing surface. Implemented inline with no build step or dependencies
- **Settings**: Server port and host, controller connection and API token, auto-sync interval, logging level, backup/restore
- **Test Tools**: door unlock testing, custom event simulation, connectivity test, raw event payload viewer

## Configuration

The app reads from `config/config.json` at startup. Key settings:
- `server.port`: Set to **5000** for Replit webview
- `server.host`: Set to `0.0.0.0`
- `unifi.host`: IP of the UniFi Access controller (local network)
- `unifi.token`: UniFi Access API token
- `unifi.port`: Default `12445`

### Automation Format (the door flow)

`door_flows` is the sole persisted automation shape, keyed by door name. Each door holds `triggers`; each trigger has a `type` (`entry` or `doorbell`), a `scope` (`null` for everyone, `{ any_group: true }` for any resolved group, or `{ groups: [...] }`), and `actions` (an `unlock` of other doors with `debounce_seconds` + `delay_seconds`, and a `retract` list of per edge deadbolt commands each with its own `after_unlock`):

```json
"door_flows": {
  "Front Door": {
    "door_id": "abc123",
    "triggers": [
      { "type": "entry", "scope": { "groups": ["GroupA"] },
        "actions": { "unlock": { "doors": ["Lobby", "Elevator"], "debounce_seconds": 8, "delay_seconds": 0 },
                     "retract": [ { "lock_id": "front_deadbolt", "after_unlock": "stay_unlocked" } ] } }
    ]
  }
}
```

Backward compatibility: on load, `migrateToTriggers` folds the earlier `unlock_rules`, `doorbell_rules`, `deadbolt_rules`, and `cascade_rules` (including the legacy `trigger_location` + `group_actions` shape) into `door_flows`, then deletes them from disk. `GET /api/config` projects those old shapes read-only for one transition release.

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

## Auto-Reload Job (Config Sync)

- **Module**: `src/config-sync.js` — periodic background job, exports `ConfigSync` class with `start({enabled, intervalSeconds})`, `stop()`, `markConfigApplied()`, `resyncControllerBaselines()`, `getState()`.
- **Detection**:
  - **Local**: `config/config.json` mtime + sha256. If both differ from baseline, treat as an external edit and call `onConfigFileChanged`.
  - **Upstream**: each tick calls `unifiClient.discoverDoors()` and `unifiClient.syncUserGroups()` (existing GET-only helpers), then sha256-hashes the sorted door-id list and the user-id→group-name map. Diffs trigger `onControllerDoorsChanged` / `onControllerUsersChanged`.
- **Read-only contract**: the sync job NEVER writes to `config/config.json` and NEVER PATCHes/POSTs to the controller. Friendly door names, logical group names, rule wording — all user-authored fields stay exactly as the operator saved them.
- **Wiring** (`src/index.js`):
  - `initConfigSync()` constructs the singleton; `applyAutoSyncFromConfig()` reads `config.auto_sync` and starts/stops it.
  - Started after `start()` finishes initial UniFi init. Stopped on SIGTERM/SIGINT and at the top of `reloadOrchestrator()` to avoid overlap (re-applied in `finally`).
  - `reloadOrchestrator(reason)` is the shared reload helper used by config-file-changed callbacks. Manual `POST /reload`, `PUT /api/config`, and restore endpoints continue to call `reloadServices()` directly with their own SSE event types.
  - `markConfigApplied()` is called after every in-process write (`PUT /api/config`, `POST /api/backups/restore`) so the next tick doesn't false-trigger a reload.
- **Config keys** (`config.auto_sync`): `enabled` (default `true`), `interval_seconds` (default `15`, clamped 5–600).
- **`/health`**: includes `auto_sync.{enabled, interval_seconds, last_run_at, last_change_detected_at, last_error}`.
- **SSE**: `system.auto_reload` event with `reason` field (`config_file_changed` / `controller_doors_changed` / `controller_users_changed`). Dashboard listener auto-runs `loadConfig()` so the Configuration tab refreshes in place.
- **UI**:
  - Settings tab → "Auto-Sync" card with enable toggle + interval input (5–600s, validated client-side).
  - Configuration tab header → status pill `Auto-sync: on • last sync Ns ago` (or `off`, or red on error). Updates via the existing 10s `/health` poll and on every `system.auto_reload` SSE event.

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

## UniFi API Token — Minimum Permissions

The orchestrator only needs **read** on most scopes. It performs writes in a small number of well-defined cases:

| Scope          | Required level | Why                                                                           |
|----------------|----------------|-------------------------------------------------------------------------------|
| Locations      | **Edit**       | `PUT /doors/:id/unlock` (cascade unlocks) and `PUT /doors/:id/lock_rule` (only used if `auto_lock.buttons` is configured). |
| User           | View           | `GET /users` for the periodic name/group sync.                                |
| User Group     | View           | `GET /user_groups` + `GET /user_groups/:id/users/all` to build the group cache. |
| System Log     | View           | Optional, used only for connectivity diagnostics.                             |
| Webhook        | **Edit**       | Only required when **Event Source = API Webhook** (`POST /webhooks/endpoints` to register the orchestrator endpoint). Not needed for WebSocket or Alarm Manager modes. |
| Visitor        | View (or none) | Not used. Set to View if your token UI requires a value.                      |
| Space / Holiday Group / Schedule / Resource | None | Not used. |

### Recommended minimum for typical deployments

- **WebSocket mode (most common)**, no `auto_lock` buttons:
  - Locations: **Edit**
  - User + User Group: **View**
  - Everything else: None
- **API Webhook mode**: same as above plus **Webhook: Edit**.
- **Alarm Manager mode**: same as WebSocket mode — Webhook permission is not required.

If `auto_lock.buttons` in `config.json` is empty (default), `setDoorLockRule` is never called; Locations:Edit is still required for unlock writes.

## Production Data Fix — Tenant Group Mapping (2026-05)

Cascading inner-door unlocks (e.g. inner glass stair door not opening after a
Claussen badge at the main entrance) were caused by a name mismatch between
`unlock_rules[].group` strings and the actual UniFi user group names. The
resolver returned the raw UniFi group name, no rule matched, and only the
controller-native main door unlock fired.

To repair an existing deployment:

1. Open the **Configuration** tab → **User Groups** card.
2. For each row, set the **Logical Name** to exactly what the rules use. The
   four production tenants are:
   - `Claussen Weires PLLC`
   - `Lane & Ducheine, PL`
   - `Rosemurgy Properties`
   - `AnswersMD`
3. Click **Save Group Mappings**. The Event Source pill should stay green
   (no full reconnect — rules-only changes are now hot-applied).
4. In **Test Tools → Test Configured Rules**, run one simulation per tenant
   to confirm the cascade fires.

The dev-mode `config/config.json` in this repo ships with identity mappings
for these four tenants as a reference — they're harmless if the controller
groups already match, and serve as a template if rules are pasted in.

## Notes

- The setup wizard shows on first run when no controller is configured. Users can skip it and configure later from the Settings tab.
- The server starts listening immediately; UniFi client initialization happens in the background so the dashboard is always accessible.
- The `unifi-access-app/` subdirectory and `unifi-access-orchestrator-app.tar.gz` are source archives bundled with the repo.
