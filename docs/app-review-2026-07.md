# Full application review and self-healing plan (July 2026, baseline v7.8.0)

This review was triggered by a field failure: a deadbolt unlock failed with
the lock sitting less than a foot from the Z-Wave stick, on a box that will
ultimately live unattended in a network rack. It covers why the unlock most
likely failed, what the review of the whole app found, and the expansion work
now planned. Companion docs: `orchestrator-addon-plan.md` (original design),
`orchestrator-addon-handoff.md` (build state), `pc-bringup-runbook.md`
(hardware bring-up).

## 1. Why the unlock failed

At under a foot, weak RF range between the stick and the lock is effectively
ruled out. The realistic suspects, in order, each with a way to confirm:

1. **Stale build.** The last field diagnostics reported v7.7.3. The state
   recovery fix (interview race, dead-node recovery, truthful link state)
   shipped in v7.8.0. On 7.7.3 a node that browned out during the pairing
   interview stays dead forever from the app's point of view.
   Confirm: the version in the header or diagnostics `app_version`.
2. **Lock batteries.** Battery deadbolts routinely complete the S2 join and
   then brown out during the interview burst. Weak cells are the most common
   cause of "paired but presumed dead" at close range.
   Confirm: fresh batteries, then Re-interview / Heal.
3. **Host-side USB.** Windows USB selective suspend or a noisy USB3 port can
   stall the stick's serial link. zwave-js then marks the NODE dead when the
   local link is what actually died. Matches a "worked, then dropped" pattern.
   Confirm: USB2 port, short extension lead, selective suspend off (see the
   runbook snippet in section 4), retry.
4. **The app's own resilience gaps (now fixed, see section 2).** A driver
   error or failed boot init used to leave a dead driver that still claimed
   to be running; every command then failed with a generic "not verified"
   until someone restarted the app. Indistinguishable from a dead lock in the
   old UI, which is why confirmation was so hard.
5. **Stick firmware.** 700/800 series sticks (the ZST39 included) have known
   SDK issues that can wedge the radio until a soft reset. zwave-js works
   around most of them, but old stick firmware still produces spurious dead
   nodes. Confirm: check for a Zooz firmware update for the ZST39.

Fast triage on any future failure: `GET /api/devices` gives
`lock_state.linkState` (offline means dead node or lost driver, asleep means
press the keypad, online with a failure means interview race or transient),
and `GET /api/diagnostics` gives `zwave.driver_running` plus the new
`zwave.self_heal` block (false or a climbing restart count points at the
driver/USB family). The new Health Check button turns "why is it dropping"
into numbers: ping, RTT, RSSI, route, and a 0 to 10 lifeline rating.

## 2. Self-healing (why and what)

Requirement: the box lives in a rack; nobody watches it. After power
outages, USB flaps, network drops, or driver crashes it must recover by
itself and alert only when it truly cannot. The app now heals at four
layers:

| Layer | Failure | Healing behavior |
| --- | --- | --- |
| Host | Power outage | Packaged app registers start-at-login (config `server.start_at_login`, default on). BIOS "restore AC power" and the USB notes below complete the story. |
| Driver | Stick unplugged, serial stall, driver crash | The manager tears the dead driver down and auto-restarts on a capped backoff (5s doubling to 60s, forever). The lock driver rebuilds automatically on `driver-restarted`. An explicit stop cancels healing. |
| Lock driver | Init failed at boot (port not enumerated yet, briefly busy) | Init retries on a capped backoff (10s doubling to 5min, forever) instead of staying dead until restart. |
| Node | Lock marked Dead (brownout, interference) | Revival ladder pings the node on a capped backoff (30s doubling to 10min, forever). A successful ping flips it alive and re-seeds state; a node that was never fully interviewed gets an automatic re-interview (rate limited to hourly). Every lock/unlock against a Dead node pings once first. |

Alerting is unchanged and still gated by the sustained-offline monitor, so
the ladder retrying does not spam; `deadbolt_lock_offline` fires only when
healing keeps failing past the grace window, and `deadbolt_lock_online`
reports self-recovery.

Commands against a driver that never came up now fail fast with the truth
("Z-Wave driver is not running...") instead of burning 24 seconds and
reporting "not verified".

## 3. Review findings (what the sweep confirmed)

Three read-only review passes covered the unlock path end to end, the Z-Wave
subsystem against the hardening brief, and the original expansion brief
against what is already built. Highlights:

Already built and solid: dual event ingestion (webhook and WebSocket, with
self-registration), HMAC-signed webhook with replay guard, retract on entry,
interior cascade with debounce, lock on secured, self-trigger prevention,
remote unlock client, the full Z-Wave stack (manager, lock driver, in-app S2
pairing and exclusion, crypto shim, state recovery), a webhook notifier with
de-dupe, sustained link monitors, secrets redaction with 0600 atomic writes,
admin API key, health and diagnostics endpoints, Electron plus headless run
modes, and a Pi systemd unit. The suite is 152 tests green.

Defects found and fixed in this change: no driver reconnect (the big one),
zombie lock driver after failed boot init, misleading "not verified" for
driver-side outages, no automatic dead-node revival, no measured node health
surface.

Also shipped in this change set (originally phase 2 of the plan): backoff
between verify retries (`retry_backoff_ms`, doubling per attempt),
`poll_minutes` periodic bolt and battery refresh (drift is noticed within
one poll instead of at the next entry event), `deadbolt_low_battery` and
`deadbolt_jammed` alert events (edge triggered, re-armed on recovery, wired
through the existing notifier de-dupe), a jam-specific command error, and
the explicit `interview.queryAllUserCodes: false` guard (the Yale
battery-drain mitigation from zwave-js issue 2725; the default is already
safe, the guard makes it permanent).

Follow-up on that guard (2026-07 field incident): with `queryAllUserCodes`
off, zwave-js does not query codes on an INITIAL interview, it clears them
all on the device ("Initial interview, clearing all user codes..."). A lost
network cache therefore silently wiped every keypad code on a paired lock,
because the zwave-js default cache location (`<cwd>/cache`) sits inside the
install directory on packaged builds and app updates delete it. The app now
keeps the cache in a persistent per-user dir (default
`<config dir>/zwave-cache`, override with `devices.zwave.cache_dir` or
`ZWAVE_CACHE_DIR`), migrates any cache stranded in the old location, and
after every completed node interview verifies each SAVED code slot and
rewrites only the wiped ones (targeted per-slot reads and writes, so the
battery guard is preserved).

Known gaps deliberately deferred to the next phases: notifier channels
beyond the generic webhook (Slack or Teams, SMTP email, ntfy, severity
levels), `*_env` secret indirection, an optional UniFi-native webhook
signature scheme, a webhook-mode event-inactivity monitor, lock-on-exit as
an opt-in automation, and Windows service packaging notes.

One release-pipeline finding: every GitHub release ever cut is still a
draft, so the in-app auto-updater has never had anything to install.
Publishing releases is required for the updater to do its job on the
unattended box.

## 4. Operator runbook for the current failure

1. Install a build of v7.8.1 or later (this branch). Confirm the version in
   the header.
2. Put fresh batteries in the lock.
3. Move the stick to a USB2 port on a short extension. On Windows, disable
   USB selective suspend:
   `powercfg /setacvalueindex scheme_current 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb3f3b6a92 0`
   then `powercfg /setactive scheme_current`. Also set BIOS "restore on AC
   power" so the mini PC boots after an outage.
4. Open the dashboard, Smart Deadbolt section: the paired-locks table shows
   every saved lock and every node on the stick. Click Re-interview / Heal,
   then wake the lock at the keypad. Bolt, battery, and link should populate
   within a minute.
5. Click Health Check and note the numbers. Ping ok with a sane RSSI and a
   direct route means the radio side is healthy. Repeated ping failures with
   a running driver mean the lock side (batteries first). Driver restarts
   climbing in diagnostics `zwave.self_heal.auto_restarts` mean the USB side.
6. Test Unlock. If it still fails, Download Diagnostics immediately and send
   the bundle; it now contains the self-heal state and the last health-check
   numbers alongside the logs.

## 5. Expansion plan (phases)

1. Self-healing ladder plus locks inventory and per-lock unpair: this change.
2. Verification hardening: retry backoff, `poll_minutes` refresh, low-battery
   and jam alerts, the explicit user-code interview guard.
3. Notifier expansion: channel abstraction (generic webhook or ntfy, Slack or
   Teams, SMTP email), severity levels, config-driven any-subset.
4. Config and security polish: `*_env` secret indirection, optional
   UniFi-native webhook signatures, webhook-mode inactivity monitor,
   lock-on-exit opt-in.
5. Ops: publish releases (auto-updater), Windows service packaging notes.

Acceptance drills for the self-healing work, run on site: pull the mini PC's
power and restore it (app returns, deadbolt works, zero touch); pull the
stick mid-run and replug it after two minutes (driver auto-restarts, lock
recovers); pull the lock's batteries and reinsert them (revival ladder
brings it back without pressing anything); drop the network to the UDM and
restore it (event stream reconnects, next badge entry retracts).
