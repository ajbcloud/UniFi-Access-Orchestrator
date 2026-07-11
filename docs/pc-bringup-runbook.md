# PC Bring-Up Runbook: Smart Deadbolt (Zooz ZST39 + Schlage BE469ZP)

Audience: the person standing at the Windows PC with the hardware. Work top
to bottom; every box is pass/fail. If a step fails, note what the dashboard
showed and grab the matching lines from the log (File menu, Open Log Folder)
before moving on.

Software prerequisite: UniFi Access Orchestrator v7.1.0 or later (the first
release containing in-app pairing).

---

## 1. Before you start

- [ ] Back up the config: File menu, Open Config Folder, copy `config.json`
      somewhere safe.
- [ ] Have the lock's **5-digit PIN**: printed on the label on the lock body
      (also on the box sticker). This is the first block of the DSK.
- [ ] Have the lock's **6-digit programming code**: on the same label unless
      it was changed.
- [ ] Fresh batteries in the BE469ZP.
- [ ] For pairing only: the lock within a few feet of the PC (classic Z-Wave
      inclusion is short range). It can be moved/installed afterward.

## 2. Install the release

- [ ] Run `UniFi Access Orchestrator Setup 7.1.0.exe` over the existing
      install.
- [ ] App boots; dashboard loads; window title shows the connection state.
- [ ] Config SURVIVED the upgrade: doors, rules and controller settings are
      intact (compare against the backup if unsure).
- [ ] The tray icon is VISIBLE (this was blank in older builds); its context
      menu works.
- [ ] Walk the app menu once: setup wizard, connectivity test, docs, tab
      shortcuts.

## 3. Enable the Z-Wave transport

- [ ] Plug the ZST39 into a USB port (a USB 2.0 extension cable helps radio
      performance if the PC is metal-cased).
- [ ] Configuration tab, Smart Deadbolt (Z-Wave) section, click Refresh
      Ports.
- [ ] Pick the port marked "(likely Z-Wave stick)". If NO port appears:
      unplug/replug the stick, refresh again, and make sure no other Z-Wave
      software is running.
- [ ] Tick "Enable Z-Wave deadbolt", Save. Expect the saved toast; the
      Deadbolt block below now shows "No lock paired yet."

## 4. Pair the lock

- [ ] Click **Pair New Lock**. The panel says it is starting, then waiting
      for the lock.
- [ ] On the lock: enter the 6-digit programming code, press the Schlage
      button, then press **0**.
- [ ] The panel shows the lock's device ID and asks for the PIN. Type the
      5-digit label PIN and submit.
- [ ] Expect "Paired!" with a node number, then live bolt state, battery,
      and link in the panel.
- [ ] If it fails with "joined WITHOUT S2 security": run **Unpair** (
      programming code, Schlage button, **0** puts the lock in exclusion
      mode), move the stick closer to the lock, double-check the PIN, and
      pair again.
- [ ] If the lock was EVER paired to another controller before: exclude it
      first (Unpair flow works even for locks joined elsewhere) or factory
      reset it, then pair.

## 5. Bench tests (lock on the table or installed)

- [ ] **Test Unlock**: bolt physically retracts; badge flips to "unlocked".
- [ ] **Test Lock**: bolt throws; badge flips to "locked".
- [ ] Jam handling: hold the bolt back by hand and Test Lock. Expect a
      FAILED result (and a "jammed" state), never a false success.
- [ ] Link-loss alert: with `alerts.enabled: true` and a `webhook_url` set
      in the config, unplug the stick and wait 2+ minutes. Expect a
      `deadbolt_lock_offline` alert at the webhook and in Live Events.
      Replug and expect the recovery alert.
- [ ] Restart the app: the lock re-seeds its state within a minute (the
      BE469ZP is slow; give it time).

## 6. Automation

- [ ] In Deadbolt Automation, set the retract trigger door (the front door
      reader) and Save Trigger.
- [ ] Add a cascade rule: trigger = front door, unlock = the interior door,
      debounce 8s. It applies immediately, no restart.
- [ ] Badge in at the front door: the deadbolt retracts and the interior
      strike releases once. Rapid repeat badging within the debounce window
      does NOT re-fire the cascade.
- [ ] Perform the Double-Badge Override (lock-up gesture): the mag lock
      engages and the deadbolt throws shortly after (lock-on-secured
      mirrors the controller's lock state).
- [ ] Measure the badge-to-retract delay. If it feels slow at the door, see
      the plan doc about schedule-aligned morning retract as an alternative
      to badge-triggered retract.

## 7. Fail-safe drills (do not skip)

- [ ] Quit the app entirely. Badge entry during business hours still works
      natively (UniFi schedule), and the Schlage self-locks on its own
      auto-lock. The middleware being down must never block entry or
      securing.
- [ ] Confirm the keypad code works as the manual entry backstop.
- [ ] Egress is untouched: interior exit (REX, push-to-exit, thumb turn)
      works with the app running and with it stopped.

## 8. Optional: payload capture for tuning

If any rule needs adjusting to real controller payloads, record one gesture:
`POST /api/capture/start {"label":"double-badge"}` (admin key required),
perform the gesture, `POST /api/capture/stop`, then `GET /api/capture` to
inspect the raw events.

---

Housekeeping note for the repo owner: the merged working branches
(`claude/deadbolt-pairing`, `claude/deadbolt-followons`, and older
`claude/*`) can be deleted in the GitHub UI. Deleting a stacked PR's base
branch promptly also avoids the retarget pitfall that #17 had to correct.
