# Smart-Deadbolt Add-on: Handoff and Test Guide

Audience: the Replit agent (and a human) picking up hardware bring-up, on-site
capture, and deployment. This documents what is built, what is verified, what
remains, and exactly how to test it.

Companion docs in this repo:
- `docs/orchestrator-addon-plan.md`: the full design/plan and open questions.
- The QIT AC2 site design (Draft 1.9): owns the physical site design, BOM,
  Configuration 1 schedule, life-safety, and the BTS/QIT responsibility split.

Branch: `claude/comprehensive-review-x9e1kk`.

---

## 1. Status at a glance

| Piece | State |
|---|---|
| Lock driver seam (`LockDriver`) | Built |
| Z-Wave Schlage adapter (`ZwaveLock`) | Built, unit-tested with a mock node; NOT yet run against real hardware |
| Fake lock (dev/dry-run) | Built |
| Deadbolt controller (retract / lock / cascade) | Built, unit-tested, verified end-to-end in a running server with the fake lock |
| Event capture mode | Built, verified in a running server |
| Orchestrator wiring (index.js) | Built, verified boots + processes events with the add-on active |
| Unit tests | 32 passing (`npm test`) |
| zwave-js dependency | NOT installed / NOT in package.json (deliberate, see below) |
| S2 pairing with the real lock | Not done (needs hardware) |
| On-site payload confirmation (double-badge, extra echo) | Not done (needs the live console) |
| Outbound alerting notifier | Built + verified (posts JSON to a webhook), wired to deadbolt alerts |
| Dashboard device card | Built + verified (render + XSS-safe); cascade-rule editor still optional |

Nothing here changes behavior for a deployment that has not configured
`deadbolt_rules`/`cascade_rules`. The add-on is inert by default.

---

## 2. What was verified, and how

Run `npm test` (32 tests, all passing): driver verify/retry/jam/offline, and
the controller's retract/cascade/lock/self-trigger/debounce logic over captured
event shapes.

End-to-end against a running server (fake lock, no hardware):
- Boot with `MIDDLEWARE_CONFIG_PATH=<a config with deadbolt_rules>` and
  `devices.zwave.enabled=false` (fake lock).
- `POST /webhook` a real `access.logs.add` entry for the Front Door with
  `result: ACCESS` -> the deadbolt retracts (`/health` `deadbolt.stats.retracts=1`,
  bolt `unlocked`), and the interior cascade is attempted (fails cleanly with no
  live controller: `cascades_failed=1`).
- `POST /webhook` an `access.data.v2.location.update` with `state.lock=locked`
  for the Front Door -> the deadbolt is thrown (`locks=1`).
- `POST /api/capture/start` then the event -> the raw event is recorded and
  written to `captures/capture_<label>.jsonl`.

What is NOT verified (needs hardware / the live console): the real zwave-js
driver against the Schlage, S2 pairing, and the exact bytes a Double-Badge
Override emits.

---

## 3. Architecture (files)

New:
- `src/drivers/lock-driver.js`: `LockDriver` contract + `LockState`.
- `src/drivers/zwave-lock.js`: Schlage BE469ZP over zwave-js (Door Lock CC
  0x62 set/get; Notification CC 0x71 Access Control for unsolicited changes and
  jam 0x0b; Battery CC 0x80). Verify-after-command with a generous timeout,
  retry, and jam-is-terminal. zwave-js is INJECTED (`driverFactory`/`node`) for
  testability and lazy-required in production.
- `src/drivers/fake-lock.js`: in-memory lock for dev and tests.
- `src/deadbolt-controller.js`: the event-to-action brain. Parses raw events
  itself (independent of the engine's telemetry filter) and drives the three
  behaviors.
- `src/capture.js`: labeled full-fidelity event recorder.
- `src/notifier.js`: outbound alerting (posts JSON to a configurable webhook,
  per-type de-dupe, injected HTTP sender for tests).
- `test/drivers.test.js`, `test/deadbolt-controller.test.js`, `test/notifier.test.js`,
  `test/dashboard-render.test.js`: unit tests.
- `config/config.deadbolt.example.json`: full add-on config template.

Changed:
- `src/unifi-client.js`: `setRawTap(fn)` forwards every parsed WS event to
  observers before whitelisting (so the `location.update` lock signal is not
  filtered). Null by default.
- `src/index.js`: constructs the add-on (gated), taps webhook + WS events, adds
  `/api/devices` and `/api/capture/*`, `/health` fields, reload re-tap, and
  lock-driver shutdown.
- `public/index.html`: a Smart Deadbolt card on the Dashboard tab (bolt state,
  battery, link, trigger door, last action, totals), populated from `/health` on
  the existing 10s poll and hidden unless the add-on is enabled. Controller-derived
  strings are escaped.
- `package.json`: `test` script and `engines: node>=20`.
- `.gitignore`: `config/captures/`.

Data flow: UniFi WS/webhook -> `unifiClient` raw tap (and the webhook handler)
-> `capture.add()` + `deadboltController.observe(raw)` -> parse -> retract /
lock (Z-Wave via `LockDriver`) or cascade (interior door via the unlock-only
`unifiClient.unlockDoorByName`). The rules engine's existing path is untouched.

---

## 4. Behavior

- Retract on entry: any front-door `access.logs.add` with `result=ACCESS` that
  is not self-triggered -> `lockDriver.unlock()`. (At a single exterior reader
  every credential grant is an entry, so no direction field is required; an
  explicit `exit` direction, if ever present, is ignored.)
- Lock on secured: `access.data.v2.location.update` (or legacy
  `access.data.device.location_update_v2`) for the front door with `state.lock`
  transitioning to `locked` -> `lockDriver.lock()`. This mirrors the mag-lock
  state, so it covers Double-Badge Override, Lock Now, and scheduled auto-lock.
- Interior cascade: same trigger as retract -> momentary
  `unlockDoorByName(interiorDoor)` per `cascade_rules`, debounced.
- Self-trigger prevention: skip events whose actor is the orchestrator
  (`self_trigger_actor_name`, default "Access Orchestrator") or whose
  `credential_provider` is `REMOTE_THROUGH_UAH`.
- Failure handling: a failed retract raises a high-severity alert (entry
  blocked); a failed lock raises a low-severity alert (Schlage auto-lock
  backstops it); a failed cascade raises an alert (interior reader still works
  natively).

UniFi is never sent a lock command. The only lock verb is on the Z-Wave side.

---

## 5. How to enable and configure

1. Copy `config/config.deadbolt.example.json` to your `config.json` and fill in
   `server.admin_api_key`, `unifi.host`, `unifi.token`. Keep
   `event_source.mode: "websocket"` (required so the lock-on-secured signal is
   received).
2. Set the door names in `deadbolt_rules.trigger_door` and
   `cascade_rules.rules[].trigger_door`/`unlock` to match the UniFi door names
   exactly.
3. Until the hardware is paired, leave `devices.zwave.enabled: false` to run
   with the fake lock (cascade still works against the real controller; the
   deadbolt is simulated).
4. To drive the real lock, set `devices.zwave.enabled: true`, the
   `serial_path` (use `/dev/serial/by-id/...`), and the `node_id` from S2
   pairing. Provide S2 keys via environment variables, NOT the config file:
   `ZWAVE_S2_ACCESS_CONTROL`, `ZWAVE_S2_AUTHENTICATED`,
   `ZWAVE_S2_UNAUTHENTICATED`, `ZWAVE_S0_LEGACY` (32 hex chars each).

Endpoints (admin-gated when `admin_api_key` is set):
- `GET /health` -> includes `deadbolt` and `capture` status.
- `GET /api/devices` -> live lock state.
- `POST /api/capture/start {label}`, `POST /api/capture/stop`,
  `POST /api/capture/label {label}`, `GET /api/capture?limit=N`.

---

## 6. Remaining work (ordered)

1. Install zwave-js on the middleware host. It is intentionally not in
   package.json so a client without the deadbolt can `npm install` without a
   native build. Confirm the current version against npm, then
   `npm install zwave-js@<version>`. Verify the exact option names against that
   version: `securityKeys` / `securityKeysLongRange`, `storage.cacheDir`, and
   the inclusion callbacks container (`inclusionUserCallbacks` with
   `grantSecurityClasses` and `validateDSKAndEnterPIN`). Adjust
   `src/drivers/zwave-lock.js` `_createDriver()` if the API differs.
2. Host serial setup (Linux): find the stable path with
   `ls -l /dev/serial/by-id/`; stop ModemManager from grabbing the CP210x
   (`systemctl mask ModemManager` or a udev `ID_MM_DEVICE_IGNORE=1` rule); add
   the service user to the serial group. Confirm a known-good ZST39 firmware
   (there is a documented lockup bug on some SDK 7.2x builds).
3. S2 pairing. Add a one-time pairing command/flow (inclusion at S2 Access
   Control, DSK/PIN from the lock label). Record the resulting `node_id` in
   config. This is the only piece the adapter does not yet script.
4. On-site capture (one short session) to confirm the two remaining unknowns:
   start a capture, perform a Double-Badge Override, and confirm it emits the
   `location.update` lock flip (and/or `unlock_schedule.deactivate`); and
   confirm whether a self-issued unlock's custom `extra` echoes on the stream
   (if not, the actor discriminator already covers self-trigger prevention).
5. Bench and site tests per section 7.
6. DONE: outbound alerting. `src/notifier.js` posts a JSON alert to
   `config.alerts.webhook_url` (per-type de-dupe, filtered by `alerts.on`), wired
   to the deadbolt `onAlert` and exposed at `/health` `alerts`. Verified
   end-to-end (a failed cascade delivered a `cascade_failed` alert to a webhook).
   Follow-on if wanted: also fire alerts on controller disconnect and sustained
   unlock failures (would tap the UniFi health monitor), and add an email/SMTP
   channel (needs a dependency).
7. PARTLY DONE: dashboard device card. The Smart Deadbolt card (bolt state,
   battery, link, last action, totals) is built on the Dashboard tab, fed by
   `/health` on the 10s poll, and unit-tested for render + XSS-safety. A quick
   visual pass in a real browser is still worth doing (no browser package would
   install here). Still optional: a cascade-rule editor in the Configuration tab.
8. Optional cleanup: `src/unifi-client.js` WS whitelist still lists the
   non-real event types `access.door.lock`, `access.door.close`,
   `access.notifications` (harmless, they never fire); consider removing them
   and adding `access.data.v2.location.update` to the whitelist if you ever want
   that event to also reach the rules engine (the deadbolt controller already
   gets it via the raw tap, so this is not required).

---

## 7. Test plan

Unit (no hardware): `npm test`.

Bench (stick + lock on a table):
- S2 inclusion; record node_id.
- lock, unlock, getState; force a jam (hold the bolt) and confirm JAMMED
  surfaces; low-battery threshold.
- Unplug/replug the stick and confirm reconnect; restart the service and
  confirm state re-seeds.

Site (Suite 105), WebSocket mode:
- Capture real ENTRY, Double-Badge Override, and First-Person-In events first
  (`/api/capture`), confirm event shapes and the `extra` echo.
- entry-retract: badge in, confirm the bolt retracts; measure latency and tune
  the mag-lock unlock/relay duration to cover it.
- lock-on-secured: perform the lock-up gesture, confirm the bolt throws.
- cascade: badge at the front door, confirm the interior strike releases once;
  confirm debounce with rapid repeats; confirm it does NOT fire on the interior
  door for an exit.
- verify-state: unplug the stick mid-test, confirm the alert and the
  fail-secure result.
- orchestrator-offline: stop the service, confirm business-hours entry still
  works natively and the Schlage self-locks; confirm the keypad code is the
  documented manual entry backstop for an unoccupied-arrival.

---

## 8. Safety invariants to preserve (do not regress)

- Unlock-only on UniFi: never call `lock_rule`/lock on a UniFi door. The only
  lock verb is on the Z-Wave side.
- Life-safety: the middleware is never in the egress or fire-release path. The
  mag-lock release (fire relay, IR REX, push-to-exit) stays independent of the
  hub and the middleware. AHJ / fire-marshal sign-off gates go-live.
- No single point of failure for business-hours entry: during the scheduled
  unlock window the bolt is retracted and the mag lock is open, both native. The
  deadbolt is thrown only when the suite is unoccupied; the Schlage auto-lock
  and physical button are the primary securing mechanism, and the keypad code is
  the manual entry backstop when the middleware is down.
- Fail-secure defaults: on any ambiguous or offline case the system stays
  secured (bolt down). A partial/failed retract must alert, never silently
  report success.

---

## 9. Known caveats

- Deadbolt/cascade RULE changes require a service restart (a config reload
  re-taps events and keeps the persistent lock connection but does not rebuild
  the controller's rules). Controller/UniFi settings reload as before.
- The Z-Wave adapter's zwave-js API calls are written to the documented API but
  have not run against the live package; verify the option/method names for the
  pinned version (section 6.1) during bring-up.
- Retract latency: the BE469ZP is eventually-consistent; the verify timeout
  defaults to 12s. Prefer a schedule-aligned morning retract if badge-triggered
  retract feels slow (see the plan doc, section 4.3).
