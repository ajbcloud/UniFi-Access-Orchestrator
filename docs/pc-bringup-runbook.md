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

Use **Add a deadbolt** in the Smart Deadbolt panel: pick the manufacturer and
model, give it a name (for example "Front Door"), and the panel shows that
model's exact enroll gesture and pre-selects the right security mode. You can
add more than one lock; each is stored under its own name and appears in the
Paired locks table with its own Unpair (which shows that model's exclude and
factory-reset steps on hover). Security modes: **Auto** works for most locks
(S2 when supported, S0 otherwise); **S0 only** is the fallback for a Yale
whose S2 handshake wedges. The app persists the security keys in its 0600
config file automatically at first pairing; nothing goes in environment
variables.

### Supported models and procedures (from Add a deadbolt)

| Family | Enroll (controller in Add mode) | Exclude (Remove mode) | Factory reset | Joins at |
| --- | --- | --- | --- | --- |
| Schlage BE469ZP / BE468ZP | Schlage button, 6-digit programming code, 0 | Schlage button, programming code | hold inside PCB button ~7s | S2 (often S0) |
| Yale Assure (ZW/ZW2 module) | Master PIN # 7 # 1 # | Master PIN # 7 # 3 # | hold reset button while repowering (PIN resets to 12345678) | S0 |
| Yale Assure (ZW3 / 700-series) | Master PIN # 7 # 1 #, scan DSK/QR for S2 | Master PIN # 7 # 3 # | hold reset while repowering | S2 |
| Kwikset SmartCode 910-916 | interior button A once | button A once | hold Program while reinserting battery ~30s, press Program again | S0 |
| Kwikset Home Connect 620 | button A once, scan SmartStart QR | button A once | as above | S2 |
| Ultraloq U-Bolt Pro | keypad button 5 (blue), scan DSK | keypad button 5 (red) | app Delete+Reset, needle reset ~3s | S2 |
| Weiser / Baldwin (Home Connect) | interior button A once | button A once | hold Program while reinserting battery ~30s | S0 (620/918: S2) |
| Alfred DB1 / DB2 | Master Mode (** + passcode + #), menu 88, add | menu 88, remove | see lock manual | verify |
| Other / not listed | run the lock's inclusion sequence per its manual | run its exclusion sequence | see manual | Auto |

Exclusion is generic on the controller side (any brand); only the on-device
gesture differs, which is why the panel shows the right one per model. Alfred
and a few field details are marked "verify against the manual" in the UI.

### Schlage BE469ZP (joins at S2)

- [ ] Click **Pair New Lock** (Auto or S2 only).
- [ ] On the lock: enter the 6-digit programming code, press the Schlage
      button, then press **0**.
- [ ] The panel shows the lock's device ID and asks for the PIN. Type the
      5-digit label PIN and submit.
- [ ] Expect "Paired!" with a node number and **S2 Access Control**, then
      live bolt state, battery, and link.

### Yale Assure YRD256 (typically joins at S0; that is normal)

- [ ] If the Yale was EVER paired anywhere (including a failed attempt),
      exclude it first: click **Unpair / Exclude Device**, then on the lock:
      Master PIN, **#**, **7**, **#**, **3**, **#**. Or factory reset it.
- [ ] Click **Pair New Lock** with security mode **Auto** (use **S0 only**
      on a retry if the first attempt failed partway).
- [ ] On the lock: Master PIN, **#**, **7**, **#**, **1**, **#**.
- [ ] There is NO PIN step for an S0 join; the panel goes straight from
      waiting to done. Expect "Paired!" with **S0 Legacy**. An S2 warning in
      the logs is normal for this lock and is not a failure.
- [ ] Known Yale notes: DoorSense does not work over Z-Wave on this model
      (we do not use it), and configuration parameter 19 has a known gap in
      community templates (we do not rely on it).

### Either lock

- [ ] If it fails with "joined WITHOUT encryption": exclude the lock, move
      the stick closer, and pair again (for the Yale, retry with S0 only;
      a wedged S2 handshake cannot fall back to S0 in the same session).
- [ ] If the lock was EVER paired to another controller before: exclude it
      first (the Unpair flow works even for locks joined elsewhere) or
      factory reset it, then pair.
- [ ] After pairing, the panel and the Smart Deadbolt card show the detected
      model and the security class it joined with. Set a friendly display
      name via `devices.zwave.locks.<id>.name` in the config if wanted.

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

- [ ] In Door Flows (Automations tab), add a flow for the front door and add
      the deadbolt to it (Add Deadbolt, then Save). The after-unlock behavior
      per edge defaults to "lock default" (the app schedules nothing).
- [ ] In the same flow card, check the interior door under "Also unlock other
      doors (cascade)", debounce 8s, and Save. It applies immediately, no
      restart. (The cascade block only appears once 2+ doors are known.)
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
