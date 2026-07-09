# UniFi Access Orchestrator: Smart-Deadbolt and Cascade Add-on Plan

Status: planning only. No implementation code beyond illustrative interfaces and pseudocode.
Target repo: `ajbcloud/UniFi-Access-Orchestrator` (canonical root tree, v5.1.0).
Target site: QIT Solutions HQ, Suite 105 (two doors).

This plan is written against the app as it actually works today. Every external fact is tagged
**[confirmed]** (verified against a primary source, cited in the References section) or
**[verify on-site]** (could not be confirmed from documentation and must be captured on the bench
or on site, usually through the app's own raw-payload viewer at `GET /api/debug/payloads`).

---

## 1. Overview and how the add-on fits the existing app

### 1.1 What the app does today (confirmed against the code)

- Connects to the UniFi Access console at `https://{host}:12445/api/v1/developer/` with a Bearer API token (`src/unifi-client.js:27-31`, request helper with a 10s socket timeout at `:109-111`). **[confirmed in repo]**
- Ingests events three ways, selected by `config.event_source.mode`: Alarm Manager custom webhook (`POST /webhook`, `src/index.js:230-260`), developer-API webhook registration (`registerWebhookEndpoint`, `src/unifi-client.js:451-483`), and a developer WebSocket notifications stream (`connectWebSocket`, `src/unifi-client.js:491-577`). **[confirmed in repo]**
- Normalizes those payloads into one internal event object (`RulesEngine.normalizeEvent`, `src/rules-engine.js:145-231`), resolves the acting user to a logical group (`src/resolver.js`), matches rules, and issues momentary door unlocks (`executeUnlocks` -> `unifiClient.unlockDoorByName` -> `PUT /doors/:id/unlock`, `src/rules-engine.js:644-706`, `src/unifi-client.js:236-273`). **[confirmed in repo]**
- Runs headless under systemd on the Pi (`Restart=always`, `RestartSec=5`, hardened unit in `scripts/setup-pi.sh:100-134`) or as an Electron tray app. Serves a single-file dashboard (`public/index.html`) with a live SSE feed and a raw-payload ring buffer (`GET /api/debug/payloads`, last 30 events, `src/index.js:82-93,283-285`). **[confirmed in repo]**

### 1.2 What the add-on introduces

The add-on turns the orchestrator into the local controller for one non-UniFi device (a Z-Wave
deadbolt) and adds a room-to-room convenience unlock, without ever asking the UniFi API to lock
anything. It is the first concrete use of the "device driver" seam recommended in the code review:
UniFi becomes one driver, the Schlage deadbolt becomes a second driver, and the rules engine learns
one new verb (`lock`) that only the Z-Wave driver can service.

Four behaviors, all read-and-act, none of which UniFi can do itself:

1. Drive a Schlage BE469ZP deadbolt on the exterior front door over Z-Wave (lock, unlock, read state).
2. Retract the deadbolt on an authorized entry / first-person-in so the door is usable.
3. Lock the deadbolt on an authorized exit (a safe action any valid badge may trigger).
4. Cascade a momentary unlock to the interior door when someone is authorized in at the front door.

### 1.3 The single most important design consequence up front

Because **the entry/exit direction is present only in the WebSocket / system-log record and not in
the Alarm Manager webhook payload** ([confirmed], API PDF section 9.1.1 vs 11.2; see section 4),
behaviors 2, 3 and 4 all require a reliable direction signal, so **this site must run in
`event_source.mode = "websocket"`** (or, as a fallback, map each physical reader/device id to a
direction). Alarm Manager mode cannot drive lock-on-exit or entry-scoped cascade correctly. This is
a hard design input, not a preference.

---

## 2. Module breakdown and file changes (mapped to real files)

The repo uses a flat `src/`. The add-on adds a small `src/drivers/` folder and touches a handful of
existing files. Nothing outside these files changes.

| Area | File | Change |
|---|---|---|
| Z-Wave lock adapter (new) | `src/drivers/zwave-lock.js` | New module. Wraps `zwave-js` Driver, exposes `lock()/unlock()/getState()`, emits `state-change`, owns the S2 keys, node id, reconnect, and verification. |
| Driver interface (new, thin) | `src/drivers/driver.js` | Minimal actuator contract (`actuate(action)`, `getState()`, `capabilities`) so the engine is not hard-wired to a concrete class. The UniFi client gets a thin adapter implementing the same contract for `unlock` only. |
| Rules engine | `src/rules-engine.js` | Add direction extraction from `_source.target[]`; add a deadbolt action path (retract-on-entry, lock-on-exit) and the interior cascade; add debounce/idempotency. Generalize the terminal call from `unlockDoorByName` to a driver-routed `actuate`. Reuse existing self-trigger prevention (`isSelfTriggered`, `:729-741`). |
| Orchestrator wiring | `src/index.js` | Construct the Z-Wave driver at boot (behind `config.devices.zwave.enabled`); add `/api/devices` and lock-state to `/health`; broadcast deadbolt state over the existing SSE channel; graceful shutdown of the driver on SIGTERM/reload. |
| Config schema | `config/config.example.json` | Add `devices.zwave`, `deadbolt_rules`, and `cascade_rules` sections (section 8). Extend the `PUT /api/config` allowlist (`safeKeys`, `src/index.js:752`) to include them. |
| Config validation | `src/index.js` loadConfig / new `src/config-schema.js` | Validate and coerce the new numeric/enum fields (this is also the review's recommended validation boundary). |
| Dashboard | `public/index.html` | New device card showing bolt state, battery, last-seen and last-command result; a cascade-rule editor; surfacing of verify failures. Phase 4, not required for headless operation. |
| Deploy | `scripts/setup-pi.sh` | Add the service user to the serial group, install a udev rule so ModemManager ignores the CP210x device, and document the `/dev/serial/by-id` path. |
| Dependencies | `package.json` | Add `zwave-js` (pin an exact version). Add `engines: {node: ">=20"}` (also a review item). |

Reused as-is (no change needed): `unifiClient.unlockDoorByName` for the cascade, the WebSocket
ingestion path, the self-trigger marker, the SSE broadcaster, `src/backup.js`, and `src/logger.js`.

---

## 3. Z-Wave lock adapter design

### 3.1 Interface

```js
// src/drivers/zwave-lock.js  (illustrative, not final)
class ZwaveLock {          // implements the driver contract in src/drivers/driver.js
  constructor(cfg, logger) { /* cfg: serialPath, nodeId, keys, cacheDir, verifyTimeoutMs, verifyRetries */ }

  async init()                 // open Driver, wait 'driver ready' + node ready, seed state
  async shutdown()             // driver.destroy()

  async lock(reason)           // Door Lock CC set Secured (0xFF); returns verified result
  async unlock(reason)         // Door Lock CC set Unsecured (0x00); returns verified result
  async getState()             // { boltState:'locked'|'unlocked'|'jammed'|'unknown', battery, online, lastSeen }
  get capabilities()           // Set('lock','unlock','state','battery')

  on('state-change', cb)       // emitted from unsolicited Notification CC events
  on('offline', cb) / on('online', cb)
}
```

### 3.2 zwave-js specifics (from verification; cite before coding)

- **Controller:** `zwave-js` supports the Zooz ZST39 800-series; the 800 series uses the same driver
  path as the 700 series. **[confirmed]** Open the Driver against a stable
  `/dev/serial/by-id/usb-Silicon_Labs_CP2102N_...-if00-port0` path, never `/dev/ttyUSBx`. **[confirmed]**
  Known firmware-lockup caveat on some SDK 7.2x builds; do not blindly update firmware, and verify a
  known-good build at deploy time. **[confirmed, verify build on-site]**
- **Lock / unlock:** Door Lock CC (0x62). `node.commandClasses["Door Lock"].set(DoorLockMode.Secured /*0xFF*/)`
  and `.set(DoorLockMode.Unsecured /*0x00*/)`. **[confirmed]**
- **Read state:** `await node.commandClasses["Door Lock"].get()` returns `currentMode` / `targetMode`.
  Seed once on startup after node ready. **[confirmed]**
- **Unsolicited state change:** Notification CC (0x71), Access Control type `6`, events `1..6`
  (manual/RF/keypad lock and unlock). Subscribe with `node.on("notification", (endpoint, ccId, args) => ...)`.
  A jam surfaces as a Lock-state value `0x0b` ("Lock jammed"), not a discrete event code. **[confirmed]**
- **Battery:** Battery CC (0x80), value `level`. **[confirmed]**
- **Device quirks already encoded in the zwave-js device DB for the BE469ZP:** Supervision is disabled
  and the report timeout is raised to 10000 ms because the lock is slow to respond, and manual
  operations are not always reported promptly. Design for eventual consistency, not instant
  confirmation. **[confirmed]**

### 3.3 State source: notifications first, poll to seed and as a safety net

Treat unsolicited Notification CC (Access Control) reports as the primary truth for bolt state and
mirror them into the adapter's cached state. Do a single Door Lock CC `get()` on startup to seed
initial state, and an infrequent low-frequency poll (for example every 15-30 minutes) only as a
drift check, because aggressive polling drains a battery lock. **[confirmed as best practice]**

### 3.4 S2 secure inclusion (pairing)

- The BE469ZP supports S2 and should be included at **S2 Access Control** (the highest class it
  offers, correct for a lock). **[confirmed]**
- zwave-js keys are supplied to the Driver via the `securityKeys` option, four distinct 16-byte
  buffers: `S2_AccessControl`, `S2_Authenticated`, `S2_Unauthenticated`, `S0_Legacy`. Keys are
  **not persisted by zwave-js**; the app supplies them on every boot (from environment, not the
  config file). The node/topology cache is persisted to `storage.cacheDir`. **[confirmed; verify exact
  option key names against the pinned zwave-js version]**
- Inclusion prompts for the DSK/PIN through user callbacks (`grantSecurityClasses`,
  `validateDSKAndEnterPIN`, `abort`), delivered via the driver's `inclusionUserCallbacks` option.
  The PIN is the first block of the DSK printed on the lock. Inclusion steps time out at 240 s.
  **[confirmed method names; verify the container option key]**
- Pairing is a one-time provisioning step. Provide it as an operator command (a CLI subcommand or a
  guarded dashboard action), not part of the normal service loop. After inclusion, record the node id
  in config.

### 3.5 Lifecycle and reconnect

- Attach node handlers only after `driver.on("driver ready")`; consider the mesh ready on
  `driver.on("all nodes ready")`. Per-node events: `"ready"`, `"value updated"`, `"notification"`,
  `"dead"/"alive"`. **[confirmed]**
- On a fatal `driver.on("error")` (serial disconnect, controller lockup), tear down with
  `await driver.destroy()` and re-create the Driver against the same `by-id` path; let systemd
  (`Restart=on-failure`, already `Restart=always` in the unit) be the outer backstop. **[confirmed
  pattern; verify current recovery guidance for the pinned version]**
- USB replug re-enumerates to the same `by-id` symlink, so a rebuild reconnects cleanly.

---

## 4. Event-to-action mapping

### 4.1 How entry vs exit and grant vs deny are determined (confirmed)

- There is **one** door event type, `access.door.unlock`; there is no distinct entry, exit, grant,
  or deny type. **[confirmed, API PDF]**
- Result: in the WebSocket / log record it is `_source.event.result`, an enum `ACCESS` (granted) or
  `BLOCKED` (denied); in the webhook payload it is a human string `data.object.result`
  (for example "Access Granted"). The repo already reads `_source.event.result`
  (`src/rules-engine.js:279`). Act only on `ACCESS`. **[confirmed]**
- Direction: only in the log/WebSocket record, as a `_source.target[]` entry
  `{type:"device_config", id:"door_entry_method", display_name:"entry"|"exit"}`. It is **absent from
  the Alarm Manager webhook**. **[confirmed]** Fallback if direction is ever missing: map the firing
  reader/device id (`data.device.id` / `alias`, for example an alias like "... - Entry2") to a
  direction with an on-site lookup table. **[verify device ids/aliases on-site]**
- Actor and door: `data.actor` / `_source.actor` (`id`, `name`/`display_name`); door at
  `data.location` / a `target[]` entry. **[confirmed]**

### 4.2 Mapping table

| # | Trigger event | Condition | Action | Constraints and notes |
|---|---|---|---|---|
| 1 | `access.door.unlock` at Front door | direction = `entry`, result = `ACCESS`, not self-triggered | Z-Wave: **unlock** (retract) the deadbolt | Latency-sensitive (section 4.3). Any authorized entry retracts. |
| 2 | First-person-in at Front door | first authorized entry after arming, result = `ACCESS` | Z-Wave: **unlock** the deadbolt | No documented FPI event; **[verify on-site]** whether FPI is a distinct signal or simply the first `access.door.unlock`. Treat as behavior 1 until proven otherwise. |
| 3 | `access.door.unlock` at Front door | direction = `exit`, result = `ACCESS`, not self-triggered | Z-Wave: **lock** the deadbolt | Any valid badge may lock (safe action). Depends on a credentialed exit signal existing (open question O-1). |
| 4 | `access.door.unlock` at Front door | direction = `entry`, result = `ACCESS`, passes debounce and scope | UniFi: momentary **unlock** of the Interior door via `PUT /doors/:id/unlock` | Fires only on entry, never on exit. Debounced (section 5). |
| - | Any event carrying the self-trigger marker or actor `unifi-access-orchestrator` | - | **Ignore** | Reuses existing `isSelfTriggered` (`src/rules-engine.js:729-741`); the middleware's own interior unlock must not loop. |
| - | result = `BLOCKED`, or direction unknown, or door != Front | - | **No action**, log at info | Fail-safe: never actuate on a denied or ambiguous event. |

### 4.3 The retract-on-entry latency problem (call out)

The deadbolt is a physical bolt on the egress door. On a valid morning entry the UniFi mag lock
releases immediately (native), but the door is still bolted until the middleware sees the event and
completes a Z-Wave `unlock`, and the BE469ZP is documented to be slow and eventually-consistent.
So a first-person-in who badges and pulls the door in the same second may find it still bolted for a
few seconds.

Recommended handling, in order of preference:
1. **Schedule-based morning retract.** Retract the deadbolt at business-open time (a config schedule
   or, better, tie it to the UniFi mag-lock unlock schedule window) so the bolt is already open
   before anyone arrives. Use badge-triggered retract (behavior 1) only as a supplement for
   after-hours or early-arrival entries.
2. If badge-triggered retract is the primary path, set operator expectations (a short wait) and keep
   the verification window generous (section 6).

This also interacts with the offline story in section 9 and open question O-2.

---

## 5. Cascade unlock design (front entry -> interior door)

- **Trigger:** behavior 4 above. Front door, `direction = entry`, `result = ACCESS`, not self-triggered.
- **API call:** the existing `unifiClient.unlockDoorByName("Interior Door", reason)`, which issues
  `PUT /api/v1/developer/doors/:id/unlock` with the self-trigger marker in `extra` and
  `actor_id/actor_name` set to the orchestrator. **[confirmed endpoint; the `extra`/`actor_*` body
  fields are used by the repo but are not in the official PDF, so verify on-site that they echo back
  into events, see open question O-3]**
- **Release duration:** the `/unlock` release is momentary and **its length is fixed by the Interior
  door's Unlock Duration in the UniFi configuration, not settable per API call**. **[confirmed]** If a
  longer walk-through window is needed, change that door's unlock duration in UniFi. Do **not** use
  `lock_rule keep_unlock` to hold it, because that is a sustained state, not a momentary release, and
  edges toward "holding an egress path open" (life-safety, section 7).
- **Debounce / idempotency:** maintain a per-door last-fired timestamp; suppress a repeat cascade
  within `cascade_rules.debounce_seconds` (default 8 s) so a group of people entering on one badge, or
  a duplicate event, fires the interior release once. Also drop any event that fails `isSelfTriggered`.
- **Scope (extension point):** `cascade_rules[].scope.groups` (empty = all authorized). This reuses
  the resolver's group mapping so the cascade can later be limited to specific tenants or credentials
  without a code change. Leave it permissive for a two-door single-tenant site.
- **Failure handling:** if the interior unlock returns non-success, log an error, mark the SSE event
  as a failure (not green), and raise an alert (section 6). A failed cascade is a convenience miss,
  not a security breach: the interior reader still works natively, so the person simply badges at the
  interior door as they would without the add-on.

---

## 6. State verification and failure handling

### 6.1 Verify every deadbolt command

After each `lock()` / `unlock()`:
1. Issue the Door Lock CC set.
2. Wait up to `verify_timeout_ms` (default 12000, above the documented 10 s report timeout) for a
   Notification CC state change or a Door Lock CC report confirming the target mode.
3. On timeout, do one `getState()` read. If still not at target, retry the set once
   (`verify_retries`, default 1).
4. If still unconfirmed, declare the command failed and alert.

### 6.2 Fail-secure defaults, distinguishing the two failure directions

The two commands fail in opposite directions and must be handled differently:

- **Failed LOCK is backstopped and low-severity.** The Schlage's own auto-lock timer and physical
  button secure the door regardless, so a failed middleware lock still ends locked. Log a warning and
  alert, but do not treat it as a breach.
- **Failed UNLOCK (retract) blocks entry and is higher-severity.** The person is left at a bolted
  door. Alert immediately, and rely on the documented physical-key fallback (section 9, open question
  O-2). Never respond to a failed retract by disabling the deadbolt's auto-lock.

The system default in every ambiguous or offline case is **secured** (bolt down): the safe direction
for property security, with physical egress always independent (section 7).

### 6.3 Alerting

There is no outbound alerting in the app today (a code-review finding). This add-on needs it, so add
a small notifier used for: deadbolt command failure, deadbolt or Z-Wave stick offline, low battery,
and jam detected. Start with a generic outbound webhook plus the log, wired next to the existing
`auto_sync` settings. Keep the channel local (no cloud dependency in the control path; the notifier
is out-of-band and may target an on-prem collector or an email relay the operator chooses).

---

## 7. Security model

- **UniFi API stays unlock-only.** The middleware calls only `PUT /doors/:id/unlock`. It never calls
  `lock_rule` on a UniFi door. The mag lock and the strike are secured entirely by UniFi native
  features (unlock schedule, First Person In, Double-Badge Override, Lock Now). **[hard constraint]**
- **Least-privilege token.** The canonical unlock scope is **`edit:space`**, not a separate
  "Locations" scope. **[confirmed, API PDF; the repo's "Locations:Edit" note is the UI label]**
  Minimal set for this site: `edit:space` (unlock) + `view:space` (door discovery) + `view:device`
  (WebSocket stream) + `view:user` (the existing user/group sync). Add `view:system_log` only if you
  choose to backfill or read direction from the log API; add `edit:webhook`+`view:webhook` only if you
  register a developer-API webhook. Do not grant `edit:api_server`, credential, visitor, or policy
  scopes. **[confirmed scope names]**
- **Webhook authenticity.** If you keep Alarm Manager, note it is **not HMAC-signed by UniFi**
  **[confirmed]**, so its authenticity rests on network isolation (management VLAN) plus the
  middleware's own optional shared-secret header. Because this site needs direction anyway, prefer the
  **WebSocket** path (outbound, token-authenticated) and, if a webhook is ever used, prefer the
  **developer-API webhook**, which UniFi does sign: header `Signature: t=<unix>,v1=<hex>`, HMAC-SHA256
  over the string `"<t>.<rawBody>"`, keyed by the endpoint secret, with the timestamp usable for
  replay defense. **[confirmed]** (The repo's current `x-orchestrator-signature: sha256=<hmac>` is a
  self-defined scheme unrelated to UniFi's; align it with the real scheme if developer webhooks are used.)
- **Secrets at rest.** The Z-Wave S2 keys and the UniFi token must not sit in plaintext config. Read
  the S2 keys from environment variables (`ZWAVE_S2_*`), keep the token in config written `0600`
  (a code-review item), and redact secrets in `GET /api/config` (also a review item). The zwave-js
  network cache under `storage.cacheDir` should also be `0600`.
- **Admin surface.** Set a non-empty `server.admin_api_key`, keep the dashboard bound to the
  management VLAN interface behind a host firewall (do not bind loopback only, because webhook
  ingestion, if used, needs the LAN interface), static IP, no cloud. **[hard constraint + review items]**

---

## 8. Config schema (annotated example)

New sections only; existing sections unchanged. S2 keys are intentionally **not** here (env vars).

```jsonc
{
  "event_source": { "mode": "websocket" },   // required at this site: direction is WS-only

  "devices": {
    "zwave": {
      "enabled": true,
      "serial_path": "/dev/serial/by-id/usb-Silicon_Labs_CP2102N_XXXX-if00-port0", // stable path
      "cache_dir": "",                 // default: alongside config.json; written 0600
      "locks": {
        "front_deadbolt": {
          "node_id": 2,                // set after S2 inclusion
          "verify_timeout_ms": 12000,  // > documented 10s report timeout
          "verify_retries": 1,
          "poll_minutes": 20,          // low-frequency drift check only
          "low_battery_pct": 25
        }
      }
      // S2 keys come from env: ZWAVE_S2_ACCESS_CONTROL, ZWAVE_S2_AUTHENTICATED,
      // ZWAVE_S2_UNAUTHENTICATED, ZWAVE_S0_LEGACY  (32 hex chars each)
    }
  },

  "deadbolt_rules": {
    "lock_id": "front_deadbolt",
    "trigger_door": "Front Door",      // must match the UniFi door name exactly
    "require_result": "ACCESS",
    "retract_on": ["entry", "first_person_in"],
    "lock_on": ["exit"],
    "morning_retract": {               // preferred over badge-latency retract (section 4.3)
      "enabled": true,
      "align_to_unifi_schedule": true, // retract when the mag-lock unlock schedule opens
      "fallback_time": "07:30"         // used if the schedule window cannot be read
    }
  },

  "cascade_rules": {
    "rules": [
      {
        "trigger_door": "Front Door",
        "direction": "entry",
        "require_result": "ACCESS",
        "unlock": ["Interior Door"],   // interior door's own Unlock Duration governs the pulse
        "debounce_seconds": 8,
        "scope": { "groups": [] }      // empty = all authorized; extension point for later scoping
      }
    ]
  },

  "alerts": {
    "enabled": true,
    "webhook_url": "",                 // out-of-band, operator-chosen, local collector or relay
    "on": ["deadbolt_command_failed", "device_offline", "low_battery", "jam", "cascade_failed"]
  }
}
```

`config-sync` must continue to treat these as user-authored (never overwritten from the controller),
and `PUT /api/config` must validate/coerce the numeric and enum fields before writing.

---

## 9. Resilience and offline behavior

The governing rule: **basic entry during business hours must not depend on the middleware, and the
deadbolt must self-secure without it.**

| Component down | Basic entry (business hours) | Deadbolt security | Cascade / retract | Notes |
|---|---|---|---|---|
| Orchestrator (this app) | Works: UniFi mag-lock unlock schedule + interior reader are native | Self-secures via Schlage auto-lock timer and physical button | Both stop | See after-hours caveat below (O-2). |
| UniFi console | Hub-controlled doors follow their last-pushed schedule / local behavior; no new events reach the app | Self-secures via Schlage auto-lock | Stop (no events) | Middleware cannot see entries, so it will not retract on badge; morning-retract schedule still fires locally. |
| Z-Wave stick / deadbolt link | Unaffected | Self-secures via Schlage auto-lock; middleware cannot lock/unlock | Retract fails -> alert; cascade unaffected | Physical key fallback for after-hours entry. |
| Power loss | On restore, systemd starts the service on boot; mag lock is fail-safe wiring | Deadbolt holds its physical state; auto-lock resumes | Resume after boot | Recommend a UPS for the host. |

**The one real single-point-of-failure to name plainly (O-2):** after hours, when the deadbolt is
thrown, UniFi cannot retract it (no lock/unlock over the Access API), so a credentialed after-hours
entry depends on the middleware performing the Z-Wave retract. If the middleware is down at that
moment, a valid badge releases the mag lock but the door stays bolted, and entry falls back to a
physical key. This does not violate the business-hours no-SPOF rule (during scheduled-unlock hours the
bolt is retracted and the mag lock is open, both native), but after-hours convenience entry is
genuinely middleware-dependent. The plan's mitigations: keep the physical key as the documented
fallback, alert immediately when the deadbolt driver goes offline, and let the Schlage auto-lock plus
its physical button remain the primary securing mechanism so nothing about basic security depends on
the app.

**Life-safety (hard constraint, unchanged):** the middleware sits nowhere in the egress or
fire-release path. The mag lock's fire relay, the Bosch DS160 IR REX, and the exit button release the
mag lock independently of the hub and the middleware. The add-on never issues a sustained hold on any
UniFi door and never touches egress wiring. The deadbolt is on the front door's bolt only; egress is
always available via the interior thumbturn and the mag-lock REX regardless of bolt or middleware
state. Verify the thumbturn-retracts-bolt behavior physically during commissioning.

---

## 10. Test plan

**Unit (no hardware):**
- Rules mapping: feed recorded real payloads (captured via `GET /api/debug/payloads`) for entry,
  exit, first-person-in, denied, and self-triggered events; assert the correct action or no-op.
- Direction extraction from `_source.target[]`; result gating on `ACCESS`/`BLOCKED`.
- Debounce and idempotency for the cascade.
- Z-Wave adapter against a fake zwave-js node (mock `commandClasses["Door Lock"].set/get` and
  `notification` events): verify success, timeout-then-retry, jam, and offline paths. This fake is the
  payoff of the driver seam: the engine becomes unit-testable for the first time.

**Bench (stick + lock on a table):**
- S2 inclusion at Access Control with DSK/PIN; record the node id.
- lock, unlock, getState; pull the bolt to force a jam and confirm the jam state surfaces.
- Unplug/replug the stick and confirm reconnect; kill and restart the process (systemd) and confirm
  state re-seeds.
- Battery reporting and low-battery alert threshold.

**On-site (Suite 105):**
- Capture real ENTRY, EXIT, and First-Person-In events first (payload viewer) to confirm event
  strings, direction presence, result field, and whether the unlock `extra`/`actor_*` echo. Only then
  enable actions.
- entry-retract: badge in, confirm the bolt retracts and measure latency; validate the morning-retract
  schedule.
- exit-lock: trigger a credentialed exit (per O-1 resolution), confirm the bolt locks.
- cascade: badge at the front door, confirm the interior strike releases once, confirm debounce with
  rapid repeats, confirm it does NOT fire on exit.
- verify-state: force a lock/unlock failure (for example stick unplugged) and confirm the alert and
  the correct fail-secure result.
- orchestrator-offline: stop the service and confirm business-hours entry still works natively and the
  bolt self-locks; document the after-hours key fallback.

---

## 11. Phased rollout and milestones

- **Phase 0, discovery (no code):** capture real event payloads on site; confirm O-1, O-3, O-4, the
  FPI signal, and the reader/device ids. Choose `websocket` mode. Provision the least-privilege token.
- **Phase 1, adapter standalone:** add `zwave-js`, build `src/drivers/zwave-lock.js` and the driver
  contract, provide the pairing command, prove lock/unlock/state/jam/battery and reconnect on the
  bench. No UniFi wiring yet. Milestone: bolt controllable and observable from the service.
- **Phase 2, deadbolt behaviors (dry-run first):** wire retract-on-entry and lock-on-exit through the
  rules engine with the existing dry-run flag; verify decisions in the log before enabling real
  actuation. Add morning-retract. Milestone: bolt follows access events correctly.
- **Phase 3, interior cascade:** add `cascade_rules`, debounce, scope, and failure handling. Milestone:
  one badge at the front door releases the interior door once.
- **Phase 4, verification, alerting, dashboard:** add command verification, the notifier, the device
  state card, battery/jam surfacing, and partial/failed status (not green). Milestone: operator can
  see and be alerted about deadbolt health.
- **Phase 5, harden and hand over:** `0600` secrets and env-var S2 keys, config validation, setup-pi
  udev/ModemManager and serial-group changes, docs, and the on-site test pass signed off.

---

## 12. Risks and open questions

- **O-1 (blocking for behavior 3): how is a credentialed EXIT detected at the front door?** The site
  lists one exterior reader (G3 Reader Pro, entry-facing) plus a Bosch IR REX and an exit button for
  egress. REX and button releases typically do not produce an `access.door.unlock` with an actor and
  `result:ACCESS`. So "lock on exit on a valid badge" needs either an exit-facing credential read or a
  different signal. Confirm on-site what event, if any, an exit produces. If none carries a credential,
  lock-on-exit should fall back to the Schlage auto-lock (the backstop already covers it) or a
  door-closed-plus-timer heuristic, and behavior 3 becomes best-effort.
- **O-2 (already discussed): after-hours entry depends on the middleware to retract the bolt.** Accept
  the physical-key fallback, or widen the retract window, and alert on driver-offline. Confirm this is
  acceptable to the customer.
- **O-3: do the unlock body fields `actor_id`/`actor_name`/`extra` echo into events?** The repo's
  self-trigger prevention depends on the `extra` marker coming back. The official PDF does not document
  these fields. Verify via the payload viewer; if they do not echo, add a dedupe-on-actor/timestamp
  fallback for self-trigger prevention.
- **O-4: are the repo's event strings real?** `access.logs.add`, `access.door.lock`,
  `access.door.close`, `access.notifications` are whitelisted in `unifi-client.js` but are not in the
  official reference (`access.logs.add` is very likely the real log-push name; the others are
  unverified). Confirm by capture before relying on `access.door.lock`/`access.door.close` for any
  deadbolt state inference.
- **O-5: First Person In has no documented API event.** Behavior 2 currently collapses into behavior 1
  until a distinct signal is confirmed on-site.
- **O-6: retract latency vs the eventually-consistent Schlage.** Prefer schedule-based morning retract;
  set expectations for badge-triggered retract.
- **O-7: ZST39 firmware lockup on some SDK builds; ModemManager grabbing the serial port on Linux.**
  Pin a known-good firmware, use `/dev/serial/by-id`, and mask/ignore ModemManager for the CP210x
  device via udev.
- **O-8: `/unlock` momentary duration is not API-settable.** If the interior walk-through window is too
  short, tune the door's Unlock Duration in UniFi; do not reach for a sustained `lock_rule` hold.

---

## 13. Explicit non-goals

- No per-user PINs on the deadbolt (User Code CC is not used).
- No cloud services or external dependency in the control path.
- No lock command to the UniFi side, ever (UniFi API stays unlock-only; the mag lock and strike are
  UniFi-native).
- No design of "Configuration 2." A clean extension point is left (`cascade_rules[].scope`, the driver
  contract, and the `devices` map) but the second configuration is not specified here.
- The middleware is never placed in the egress or fire-release path.

---

## References (verification sources)

UniFi Access developer API: the official *UniFi Access API Documentation* PDF (downloadable in-console
at Access > Settings > General > Advanced > API Token), base URL `https://{host}:12445/api/v1/developer/`.
Confirmed items: unlock endpoint and `edit:space` scope and momentary/no-duration behavior (7.9);
`lock_rule` with `custom`+`interval` minutes (7.10); the single `access.door.unlock` event type; result
via `_source.event.result` (`ACCESS`/`BLOCKED`) or `data.object.result`; direction via `_source.target[]`
`door_entry_method` present on the log/WebSocket record and absent from Alarm Manager webhooks (9.1.1,
11.2); developer-webhook HMAC signing `Signature: t=..,v1=..` over `"<t>.<body>"` (11.x); permission-key
list. Community reference (labeled): hjdhjd/unifi-access, and Ubiquiti Help "Getting Started with the
Official UniFi API."

zwave-js / hardware: zwave-js official docs and GitHub (security-s2, long-range, Door Lock CC,
Notification CC, node API, the Notifications registry, and the `0x003b/be469zp.json` device config),
plus Zooz ZST39 change-log/troubleshooting and the Schlage BE469ZP product page. Confirmed items: ZST39
800-series support and `/dev/serial/by-id` guidance and the firmware-lockup caveat; Door Lock CC set/get
with `DoorLockMode.Secured/Unsecured`; Access Control notifications (type 6, events 1-6) and jam as Lock
state `0x0b`; Battery CC; S2 Access Control inclusion with `securityKeys` and `inclusionUserCallbacks`
(`grantSecurityClasses`, `validateDSKAndEnterPIN`), keys not persisted and cache under `storage.cacheDir`;
the BE469ZP compatibility flags (Supervision disabled, 10s report timeout) and its eventual-consistency
behavior; driver lifecycle events and the destroy-and-recreate reconnect pattern.

Repo files reviewed for grounding: `src/index.js`, `src/unifi-client.js`, `src/rules-engine.js`,
`src/resolver.js`, `src/config-sync.js`, `src/backup.js`, `src/logger.js`, `electron/main.js`,
`config/config.example.json`, `scripts/setup-pi.sh`, `README.md`, `replit.md`.
