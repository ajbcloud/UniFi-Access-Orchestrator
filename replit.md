# UniFi Access Orchestrator

Multi-door unlock automation for UniFi Access with a built-in admin dashboard.

## Overview

This is a headless Node.js/Express service that integrates with Ubiquiti UniFi Access to automate door unlock sequences based on configurable rules. When someone badges in at a trigger door, it automatically unlocks additional doors based on their user group. It also handles intercom/doorbell events.

## Architecture

- **Runtime**: Node.js 20
- **Framework**: Express 4
- **Real-time**: Server-Sent Events (SSE) for live dashboard updates
- **Dashboard**: Single-page HTML (`public/index.html`) served statically
- **Logging**: Winston with daily rotation

## Key Files

- `src/index.js` — Express server, all API routes, SSE event broadcasting
- `src/unifi-client.js` — UniFi Access API client (doors, users, webhooks, WebSocket)
- `src/resolver.js` — Resolves user IDs to group names
- `src/rules-engine.js` — Processes access events and decides which doors to unlock
- `src/logger.js` — Winston logger with daily file rotation
- `src/validate.js` — CLI connectivity validation tool
- `public/index.html` — Admin dashboard UI (no build step needed)
- `config/config.json` — Runtime configuration (not committed)
- `config/config.example.json` — Configuration template

## Configuration

The app reads from `config/config.json` at startup. Key settings:
- `server.port`: Set to **5000** for Replit webview
- `server.host`: Set to `0.0.0.0`
- `unifi.host`: IP of the UniFi Access controller (local network)
- `unifi.token`: UniFi Access API token
- `unifi.port`: Default `12445`

Logs are written to `./logs/` (relative to project root).

## Workflow

- **Start application**: `node src/index.js` on port 5000 (webview)

## Deployment

Configured as a **VM** deployment target (uses in-memory state + SSE/WebSocket connections).
Run command: `node src/index.js`

## Notes

- The "Initialization failed: Invalid URL" error on startup is expected when no UniFi host is configured. The dashboard still loads and the user can configure connection settings from the UI.
- The `unifi-access-app/` subdirectory and `unifi-access-orchestrator-app.tar.gz` are source archives bundled with the repo.
