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
- **Test Tools** — Door unlock testing, event simulation, connectivity test

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

## Notes

- The setup wizard shows on first run when no controller is configured. Users can skip it and configure later from the Settings tab.
- The server starts listening immediately; UniFi client initialization happens in the background so the dashboard is always accessible.
- The `unifi-access-app/` subdirectory and `unifi-access-orchestrator-app.tar.gz` are source archives bundled with the repo.
