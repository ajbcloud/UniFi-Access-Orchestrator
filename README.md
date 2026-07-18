# UniFi Access Orchestrator

Automate multi-door unlocks for [Ubiquiti UniFi Access](https://ui.com/door-access). When someone badges in at one door, automatically unlock additional doors based on who they are. When a visitor is buzzed in through the intercom, unlock doors based on which tenant answered.

Built for multi-tenant commercial buildings where different tenants need different door sequences.

Beyond door-to-door unlocks it can also drive a Z-Wave smart deadbolt (retract on entry, re-lock on secured), keep keypad PINs in sync with UniFi Access one PIN per person, and send out-of-band alerts to a webhook, Slack or Teams, or email when a lock fails, jams, or drops offline. It runs as a Windows/macOS/Linux desktop app or as a headless service on a Raspberry Pi.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Option A: Windows Desktop App](#option-a-windows-desktop-app)
- [Option B: Linux / Raspberry Pi](#option-b-linux--raspberry-pi)
- [Configuring Doors (the door flow)](#configuring-doors-the-door-flow)
- [Upgrading from an earlier version](#upgrading-from-an-earlier-version)
- [Visual Designer](#visual-designer)
- [Setting Up Alarm Manager Webhooks](#setting-up-alarm-manager-webhooks)
- [Testing Your Setup](#testing-your-setup)
- [Dashboard Guide](#dashboard-guide)
- [Pairing the Smart Deadbolt (Z-Wave)](#pairing-the-smart-deadbolt-z-wave)
- [Keypad PIN Sync](#keypad-pin-sync)
- [Notifications and Alerts](#notifications-and-alerts)
- [SIP Phone Buttons (Auto-Lock)](#sip-phone-buttons-auto-lock)
- [Configuration Reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Building from Source](#building-from-source)
- [API Reference](#api-reference)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

---

## How It Works

**Employee badges in at the front door:**

1. Employee taps their NFC card (or uses PIN, face, mobile)
2. UniFi Access grants entry through their normal access policy
3. The orchestrator receives the event and looks up the employee's user group
4. Based on their group, the orchestrator sends unlock commands for additional doors
5. Those doors re-lock automatically on their normal timers

**Visitor uses the intercom:**

1. Visitor selects a company from the intercom directory
2. That company's staff member answers (on a viewer, mobile app, or web portal)
3. Staff member presses unlock to let the visitor in
4. The orchestrator identifies which company answered
5. Based on that company, the orchestrator unlocks the doors the visitor needs to reach them

---

## Prerequisites

Before you start, you need:

1. **A UniFi Access system** running on a supported gateway (CloudKey G2+, Dream Machine Pro, or self-hosted UniFi controller)
   - Access application firmware 2.2.6 or later
2. **An API token** from your UniFi Access portal
   - Go to **Access > Settings > General**, then scroll down to **Advanced > API Token**
   - Click "Create Token" and copy it somewhere safe
3. **Your controller's IP address** (the device running UniFi Access, not unifi.ui.com)
4. **Doors and user groups already configured** in UniFi Access
5. **Network access** from the machine running the orchestrator to the controller on port 12445

---

## Option A: Windows Desktop App

Use this if you want a GUI application that runs on a Windows PC on the same network as your controller.

### Step 1: Download

Go to the [Releases page](https://github.com/ajbcloud/UniFi-Access-Orchestrator/releases/latest) and download the installer for your platform:

| Platform | File |
|----------|------|
| Windows | `UniFi-Access-Orchestrator-Setup-x.x.x.exe` |
| Linux (any distro) | `UniFi-Access-Orchestrator-x.x.x.AppImage` |
| Linux (Debian/Ubuntu/Pi) | `unifi-access-orchestrator_x.x.x_amd64.deb` |
| macOS | `UniFi-Access-Orchestrator-x.x.x.dmg` |

### Step 2: Install

1. Double-click the downloaded `.exe` file
2. If Windows SmartScreen appears, click **More info** then **Run anyway**
3. Choose your installation directory (the default is fine)
4. Click **Install**
5. When finished, click **Finish** to launch the app

### Step 3: First Run Setup

The setup wizard appears automatically the first time you open the app.

1. **Access Gateway IP Address** - Enter the local IP of your controller (example: `192.168.1.10` or `10.0.0.1`). This is NOT `unifi.ui.com`. It must be the LAN IP.
2. **API Port** - Leave as `12445` unless you changed it
3. **API Token** - Paste the token you generated in the Prerequisites step
4. **Service Port** - Leave as `3000` unless port 3000 is taken on this machine

### Step 4: Test the Connection

1. Click **Test Connection**
2. Wait a few seconds
3. If successful, you'll see "Connected! Found X doors and Y users."
4. If it fails, double-check your IP, token, and that you can reach the controller from this PC

### Step 5: Save and Connect

1. Click **Save & Connect**
2. The dashboard will load, showing your doors, users, and event stats

### Step 6: Configure Your Doors

See [Configuring Doors (the door flow)](#configuring-doors-the-door-flow) below.

### Step 7: Choose How Events Arrive

By default the orchestrator listens over a **WebSocket** to the controller, so events start flowing as soon as you connect, with no controller-side setup. That is the recommended path for most installs, and nothing more is needed here.

If you would rather have the controller push events with **Alarm Manager webhooks** (for example when it cannot hold a WebSocket open to this machine), switch the event source to webhook mode under **Configuration > Event Source**, then follow [Setting Up Alarm Manager Webhooks](#setting-up-alarm-manager-webhooks) below using this PC's IP address for the webhook URL.

### How It Runs

- The app minimizes to the **system tray** (bottom-right of your taskbar, near the clock)
- **Closing the window** does not stop the orchestrator. It keeps running in the tray.
- **Double-click the tray icon** to reopen the dashboard
- **Right-click the tray icon** for options: Open Dashboard, Open in Browser, Open Config Folder, Open Log Folder, Quit
- The orchestrator only runs while the app is open. If you restart your PC, you need to open the app again.

### Where Files Are Stored

| File | Location |
|------|----------|
| Configuration | `%APPDATA%\unifi-access-orchestrator\config.json` |
| Logs | `%APPDATA%\unifi-access-orchestrator\logs\` |
| Config backups | `%APPDATA%\unifi-access-orchestrator\backups\` |
| Z-Wave cache | `%APPDATA%\unifi-access-orchestrator\zwave-cache\` |

You can open these folders from the tray icon's right-click menu.

---

## Option B: Linux / Raspberry Pi

There are two ways to run on Linux:

**Desktop App (recommended for Linux desktops)** - Same GUI experience as Windows. Download the `.AppImage` or `.deb` from the [Releases page](https://github.com/ajbcloud/UniFi-Access-Orchestrator/releases/latest), double-click to install and run. Setup wizard, tray icon, everything works the same.

For `.AppImage`:
```bash
chmod +x UniFi-Access-Orchestrator-*.AppImage
./UniFi-Access-Orchestrator-*.AppImage
```

For `.deb` (Debian, Ubuntu, Raspberry Pi OS with desktop):
```bash
sudo dpkg -i unifi-access-orchestrator_*_amd64.deb
```
Then launch from your application menu or run `unifi-access-orchestrator` from a terminal.

**Headless Service (recommended for Raspberry Pi and servers)** - Runs 24/7 as a background service with no GUI window. Access the dashboard from a web browser on any device on the network.

Follow the steps below for the headless setup.

### Step 1: Prepare Your Device

You need a Linux machine (Ubuntu, Debian, Raspberry Pi OS) with:
- A wired Ethernet connection to the same network as your UniFi controller
- SSH access from your laptop/desktop
- A static IP address (recommended but not required)

**If using a Raspberry Pi:**
1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/) on your laptop
2. Insert your SD card
3. In the Imager, select **Raspberry Pi OS Lite (64-bit)** as the OS
4. Click the gear icon (settings) before writing:
   - Enable SSH (use password authentication)
   - Set a username and password (example: `pi` / `yourpassword`)
   - Set hostname to `unifi-orchestrator`
   - Optionally configure WiFi as a backup
5. Write the image to the SD card
6. Insert the SD card into the Pi
7. Connect the Pi via Ethernet to your network
8. Power on the Pi

### Step 2: Find the Device's IP

From your laptop, find the Pi's IP address. Try one of these:

```bash
# If you set the hostname to unifi-orchestrator:
ping unifi-orchestrator.local

# Or check your router's DHCP lease table

# Or if you have nmap:
nmap -sn 192.168.1.0/24
```

### Step 3: SSH In

```bash
ssh pi@YOUR_DEVICE_IP
```

Enter the password you set during imaging.

### Step 4: Download the Project

```bash
# Install git if not present
sudo apt install -y git

# Clone the repository
git clone https://github.com/ajbcloud/UniFi-Access-Orchestrator.git

# Enter the project directory
cd UniFi-Access-Orchestrator
```

### Step 5: Run the Setup Script

```bash
sudo bash scripts/setup-pi.sh
```

This script does everything automatically:
- Updates system packages
- Installs Node.js 22
- Creates a dedicated service user (`middleware`)
- Copies the project to `/opt/unifi-access-orchestrator`
- Installs Node.js dependencies
- Creates a systemd service
- Sets up log rotation
- Optionally configures the firewall

It takes 3-5 minutes on a Raspberry Pi. You'll see progress for each step.

### Step 6: Configure

```bash
sudo nano /opt/unifi-access-orchestrator/config/config.json
```

At minimum, change these two values:

```json
{
  "unifi": {
    "host": "YOUR_CONTROLLER_IP",
    "token": "YOUR_API_TOKEN"
  }
}
```

Replace `YOUR_CONTROLLER_IP` with your Access Gateway's LAN IP address.
Replace `YOUR_API_TOKEN` with the token you generated in Prerequisites.

Save the file: press `Ctrl+O`, then `Enter`, then `Ctrl+X` to exit nano.

### Step 7: Start the Service

```bash
# Start the orchestrator
sudo systemctl start unifi-access-orchestrator

# Enable it to start automatically on boot
sudo systemctl enable unifi-access-orchestrator

# Check that it's running
sudo systemctl status unifi-access-orchestrator
```

You should see `active (running)` in green.

### Step 8: Open the Dashboard

From any computer on the same network, open a web browser and go to:

```
http://YOUR_DEVICE_IP:3000
```

You should see the orchestrator dashboard with your doors and user counts.

### Step 9: Configure Your Doors

See [Configuring Doors (the door flow)](#configuring-doors-the-door-flow) below. You can do this from the dashboard in your browser or by editing the config file directly.

### Step 10: Choose How Events Arrive

The default event source is a **WebSocket** to the controller, which needs no controller-side setup, so most installs are done at this point. To use **Alarm Manager webhooks** instead, switch the event source to webhook mode under **Configuration > Event Source**, then follow [Setting Up Alarm Manager Webhooks](#setting-up-alarm-manager-webhooks) below using the Linux device's IP address for the webhook URL.

### Useful Commands

| What | Command |
|------|---------|
| Check if it's running | `sudo systemctl status unifi-access-orchestrator` |
| View live logs | `sudo journalctl -u unifi-access-orchestrator -f` |
| Restart after config changes | `sudo systemctl restart unifi-access-orchestrator` |
| Stop the service | `sudo systemctl stop unifi-access-orchestrator` |
| Check health via API | `curl http://localhost:3000/health` |
| Update to latest version | `cd /opt/unifi-access-orchestrator && sudo git pull && sudo npm install && sudo systemctl restart unifi-access-orchestrator` |

---

## Configuring Doors (the door flow)

Configuration starts at the door and stays there. You pick a door, choose who and what triggers it, then add actions. There is one editor for all of it: the **Door Flows** section on the Automations tab. A one door, one deadbolt site sees a single short card; a full building sees the full builder. Same mental model at every size.

### Step 1: Discover Your Doors

Open the dashboard and go to the **Configuration** tab. Under **Door Mappings**, you should see all your doors listed with their IDs. If the list is empty, click **Rediscover Doors**.

**If using the command line:**
```bash
cd /opt/unifi-access-orchestrator
npm run validate -- --doors
```

Copy the door IDs from the output into your `config.json` under the `doors` section.

### Step 2: Map Your User Groups

In the **Configuration** tab, under **User Groups**, you should see your UniFi user groups and their members. If empty, go to **Test Tools** and click **Force User Sync**.

In your config file, map each UniFi group name to a short logical name:

```json
"unifi_group_to_group": {
  "Office Staff": "office",
  "Suite 200 Tenants": "suite_200",
  "Building Management": "management"
}
```

The left side must match the group name exactly as it appears in the UniFi Access portal.

### Step 3: Set Up a Door

Under **Door Flows**, pick a door and add it. Each door card reads as a sentence in three steps:

1. **Door.** The card identity: the door name plus a small chip summarizing what it drives ("1 deadbolt", "3 doors").
2. **When.** "When [everyone | any group | a named group] enters." The group selector appears only when your site has mapped groups, so a simple site never sees it. Use **add doorbell trigger** to add a second block that fires when someone rings the doorbell.
3. **Do this.** Add actions inside the trigger:
   - **Retract deadbolt:** pick a paired lock, then choose after unlock: **stay unlocked** (the app leaves it open until something locks it) or **relock after** N seconds. Require result, follow UniFi door unlocks (also open the deadbolt when a UniFi unlock schedule or manual unlock opens the door), and the relock cooldown live under Advanced. Different doors can drive the same deadbolt differently.
   - **Unlock other doors:** check the doors to momentarily unlock (a UniFi unlock, never a lock command), with a debounce and an optional delay. This action appears only when there is another door to unlock.

When a door retracts a deadbolt, the card shows an inline note: keypad PINs on that deadbolt follow UniFi access to this door. That gating is a derived consequence of attaching the deadbolt to the door, so there is nothing extra to configure.

Behind the scenes this is one persisted shape, `door_flows`, keyed by door name. Each door holds `triggers`, each trigger has a `type` (entry or doorbell), a `scope`, and `actions`. You will rarely hand edit it, but a compact example looks like this:

```json
"door_flows": {
  "Front Door": {
    "door_id": "abc123",
    "triggers": [
      {
        "type": "entry",
        "scope": { "groups": ["office"] },
        "actions": {
          "unlock": { "doors": ["Suite 100"], "debounce_seconds": 8, "delay_seconds": 0 },
          "retract": [ { "lock_id": "front_deadbolt", "after_unlock": "stay_unlocked" } ]
        }
      }
    ]
  }
}
```

`scope` is `null` for everyone (including an unresolved user), `{ "any_group": true }` for any resolved group, or `{ "groups": ["office"] }` for named groups. A doorbell trigger adds `"doorbell": { "reason_code": 107, "viewer_to_group": { "Office Viewer": "office" } }`; the viewer map is a fallback used when the orchestrator cannot identify who answered by their user account.

### Step 4: Reload

After editing config, apply the changes:

- **Dashboard:** Click the **Reload Service** button on the Configuration tab
- **Command line:** `sudo systemctl restart unifi-access-orchestrator`
- **API:** `curl -X POST http://DEVICE_IP:3000/reload`

---

## Upgrading from an earlier version

The door flow is now the one place configuration lives, so the earlier separate keys fold into it automatically on first load. You do not need to do anything:

- `unlock_rules` (group access rules) and `doorbell_rules` (visitor rules) migrate into door triggers: the group becomes the trigger scope, and a doorbell becomes a second trigger type on the same door. A `default_action` becomes an "any resolved group" trigger, so a user in an unmapped group still gets those unlocks while a user with no resolvable group still gets nothing.
- `deadbolt_rules` and `cascade_rules` migrate into each door's retract and unlock actions, exactly as before.
- Per edge after unlock now offers two deterministic choices, **stay unlocked** and **relock after** N seconds. The old "lock default" mode depended on the lock's own hardware timer, which the app now turns off so it owns relock in software. Any old edge converts to stay unlocked, or to relock after (using the lock's known timer or 30 seconds) if that lock's hardware auto-relock was on.
- The migration is one way and idempotent. A backup of the pre-upgrade config is written to the `backups` folder before the first rewrite. For one release, `GET /api/config` still projects the old `unlock_rules`, `doorbell_rules`, `deadbolt_rules`, and `cascade_rules` shapes so any external reader keeps working; the file on disk carries `door_flows` only.

## Visual Designer

If you prefer to see your automation as a diagram instead of a list of cards, open the **Visual Designer** tab. It draws every door flow as a node graph. The designer is a read-only map: there is one editing surface, the door's card under Door Flows on the Automations tab, so the two never compete.

**What the graph shows**

- **Trigger doors** (left) feed into **user/visitor groups** (middle), which unlock **target doors** (right).
- The **Smart Deadbolt** node appears when the Z-Wave add-on is set up, wired to its retract trigger.
- Edge colors map to trigger types: blue for entry (NFC / PIN / face / mobile), purple for doorbell (buzz-in), teal for unlocking other doors, and orange for the deadbolt retract.

**Reading the map**

- Click any node to list the flows that touch it, or click an edge to see its details.
- Every detail panel deep-links to the door's card so you can make the change in the one place that owns it.

Use the on-canvas controls to zoom, **Fit** the whole graph to the view, or **Arrange** to auto-arrange the nodes. Node positions you drag are remembered on that machine.

---

## Setting Up Alarm Manager Webhooks

> **Optional.** The default event source is a WebSocket to the controller, which needs no controller-side setup. Follow this section only if you switched the event source to **API webhook / Alarm Manager** mode under Configuration > Event Source.

When running in webhook mode, the orchestrator receives events that UniFi Access pushes through Alarm Manager.

### Open Alarm Manager

1. Log into your UniFi Access portal
2. Click the **bell icon** on the left sidebar (Alarm Manager)
3. Click **Create Alarm**

### Create Rule 1: Door Unlock

| Field | What to Enter |
|-------|---------------|
| **Name** | `Orchestrator - Door Unlock` |
| **Trigger** | Select **Door Unlocked** from the Access triggers |
| **Scope** | Select the door that triggers your rules (e.g. "Front Door") |
| **Action** | Select **Custom Webhook** |

After selecting Custom Webhook:

1. Click **Advanced Settings** (this is critical)
2. Change **Method** from GET to **POST**
3. In the **URL** field, enter: `http://ORCHESTRATOR_IP:3000/webhook`
   - Replace `ORCHESTRATOR_IP` with the IP of the machine running the orchestrator
4. Save the rule

### Create Rule 2: Doorbell Answered

| Field | What to Enter |
|-------|---------------|
| **Name** | `Orchestrator - Doorbell Answered` |
| **Trigger** | Select **Doorbell Answered** from the Access triggers |
| **Scope** | Select your intercom device |
| **Action** | Select **Custom Webhook** |

Same as above:

1. Click **Advanced Settings**
2. Change Method to **POST**
3. URL: `http://ORCHESTRATOR_IP:3000/webhook`
4. Save the rule

### Why POST Matters

The Alarm Manager defaults to GET requests. GET requests don't include the event payload (the JSON body with information about who unlocked which door). You **must** change it to POST or the orchestrator won't receive any useful data.

---

## Testing Your Setup

### From the Dashboard

1. Open the dashboard (the app window on Windows, or `http://DEVICE_IP:3000` on Linux)
2. Go to the **Test Tools** tab
3. Under **Test Door Unlock**, click any door card. It should unlock and re-lock automatically.
4. Under **Simulate Event**, select an event type and location, then click **Simulate Event**. Watch the **Live Events** tab to see the orchestrator process it.

### From the Command Line

```bash
# Test unlocking a specific door
curl -X POST http://DEVICE_IP:3000/test/unlock/Front%20Door

# Simulate an NFC tap event
curl -X POST http://DEVICE_IP:3000/test/event \
  -H "Content-Type: application/json" \
  -d '{"event_type":"access.door.unlock","location":"Front Door","user_name":"Test User"}'

# Check health
curl http://DEVICE_IP:3000/health
```

### End-to-End Test

1. Make sure both Alarm Manager rules are active
2. Go to your trigger door and tap an NFC card
3. Watch the **Live Events** tab in the dashboard
4. You should see the event arrive, the group resolved, and the additional doors unlocked
5. For doorbell testing, press the doorbell at the intercom and answer from a viewer or the mobile app

---

## Dashboard Guide

The dashboard has eight tabs:

**Dashboard** - Overview showing door count, user count, events received, unlocks triggered, last event details, and system info (memory, uptime, event source mode). When a Z-Wave deadbolt is paired, a Smart Deadbolt card also appears with live bolt state, battery, and link, listing every door that triggers each lock.

**Live Events** - Real-time scrolling feed of every event. Each row shows the timestamp, event type (color-coded), who triggered it, which door, what the orchestrator did, and whether it succeeded. Events stream in automatically via Server-Sent Events.

**Automations** - Everything starts at the door. Door mappings, user groups, then **Door Flows** (pick a door, choose who and what triggers it, then say what happens: retract a deadbolt with its own after-unlock behavior, unlock other doors, or both; a doorbell is a second trigger on the same door). Buttons to rediscover doors and reload the service.

**Keypad Users** - One PIN per person, written to every deadbolt the user's UniFi door access allows and kept in sync with their UniFi Access PIN. A lock triggered by several doors admits a user who is allowed on ANY of them. See [Keypad PIN Sync](#keypad-pin-sync).

**Devices** - The hardware side of the Z-Wave deadbolts: enable the transport and pick the serial port, pair and unpair locks, run a Health Check, test lock and unlock, and watch live bolt state, battery, and link. Pairing, diagnostics, and node re-interview all live here. See [Pairing the Smart Deadbolt (Z-Wave)](#pairing-the-smart-deadbolt-z-wave).

**Visual Designer** - The door flows as a read-only node graph. Click a node or edge to see its details and deep-link to the door's card, the one place edits happen. See [Visual Designer](#visual-designer).

**Settings** - Server port and host, controller connection and API token, auto-sync interval, log level, notifications and alerts, start-at-login, and backup/restore.

**Test Tools** - Click any door to test-unlock it. Simulate events with configurable parameters. Preflight checks and a rule simulator let you dry-run a payload against your door flows before it goes live. Quick action buttons for force sync, reload, and health check.

---

## Pairing the Smart Deadbolt (Z-Wave)

The app can drive a Z-Wave deadbolt (tested design: Schlage BE469ZP over a Zooz ZST39 USB stick). Everything happens in the dashboard; no config editing is needed.

1. Plug the Z-Wave USB stick into the machine running the app.
2. Open **Automations** and find **Deadbolt Devices (Z-Wave)**. Pick the stick's port from the dropdown (likely sticks are marked), tick **Enable Z-Wave deadbolt**, and Save.
3. In **Add a deadbolt**, pick the manufacturer and model, optionally give it a name, then click **Pair this deadbolt**. When the panel says it is waiting for the lock: on the Schlage keypad, enter the 6-digit programming code, press the Schlage button, then press **0**. Keep the lock within a few feet of the stick while pairing.
4. The panel shows the lock's device ID and asks for the **5-digit PIN** printed on the label on the lock body (also on the box sticker). Type it and submit.
5. After "Paired!", the deadbolt is active: the panel shows live bolt state, battery, and link, with **Test Lock** / **Test Unlock** buttons.

To remove the lock, use **Unpair** (programming code, Schlage button, then **0** puts the lock in exclusion mode).

For the full first-time checklist (install, pairing, bench tests, automation, and fail-safe drills), follow [docs/pc-bringup-runbook.md](docs/pc-bringup-runbook.md).

Notes:
- The app generates and stores Z-Wave security keys in its config file on first pairing. Back up the config, and never delete `devices.zwave.security_keys` after pairing, or the lock will need to be excluded and re-paired.
- If pairing fails with a "joined WITHOUT S2 security" message, the PIN was likely mistyped or the signal was weak: run Unpair, move the stick close to the lock, and pair again.
- Keypad PIN gating follows whether a user's UniFi access includes at least one of the lock's trigger doors (set in Door Flows), but it does not follow UniFi access time schedules. A synced deadbolt PIN works 24/7, so a user whose UniFi access is time restricted still has a working deadbolt PIN outside those hours. This is a known limitation.

---

## Keypad PIN Sync

Once a deadbolt is paired, the **Keypad Users** tab keeps deadbolt keypad codes in step with UniFi Access, one PIN per person. You set a single PIN for a user and the orchestrator writes it to every deadbolt that person is allowed to open, and keeps it matched to their UniFi Access PIN.

**How eligibility is decided.** A user only gets a code on a deadbolt whose triggering door they are allowed to open in UniFi Access. "Which door triggers which lock" comes from the retract actions you set under Door Flows; "who may open which door" comes from each user's UniFi access policies. A lock triggered by several doors admits a user allowed on ANY of them (the union rule).

**Revocation runs automatically.** You do not have to do anything to pull a code. A background reconcile runs a few seconds after any UniFi access change (typically within 15 to 20 seconds) and removes codes that are no longer allowed:

- **Access to a triggering door removed:** the code is cleared from that lock.
- **User disabled in UniFi:** the code is cleared from every deadbolt.
- **User deleted from UniFi:** the code is cleared from every deadbolt, and the user's leftover PIN bookkeeping is pruned so nothing lingers.

**Revocation is deliberately cautious about uncertainty.** A code is only removed on a confirmed denial: UniFi returned complete access data and it shows the user has no access (or the user is gone or disabled). If the access data is unavailable or references a door group the orchestrator could not expand, the verdict is "unknown", and unknown never revokes. An API hiccup can never mass-wipe your keypad codes.

**The UniFi-side PIN is left alone.** Revocation clears only the deadbolt keypad code. It never deletes the user's UniFi Access PIN, because that is a separate building-access credential and the revocation was already triggered by a change made in UniFi. Manage the UniFi PIN in UniFi.

**Codes survive updates.** The Z-Wave network cache is kept in a persistent per-user folder (default `<config dir>/zwave-cache`, override with `devices.zwave.cache_dir` or the `ZWAVE_CACHE_DIR` environment variable) so an app update cannot wipe it. After every node interview the orchestrator verifies each saved slot and rewrites only the ones that drifted.

Time limits are not enforced on the deadbolt. A synced PIN works 24/7 even if the user's UniFi access is time restricted (see the note in the pairing section).

---

## Notifications and Alerts

The orchestrator can send an out-of-band alert when something needs a human: a deadbolt retract failed and left someone locked out, a lock jammed, a lock went offline, the controller connection dropped, a battery ran low. This matters most on an unattended box in a rack, where nobody is watching the dashboard. Configure it under **Settings**, or directly in the `alerts` block of `config.json`.

### Channels

Any subset can be enabled at once. A single alert fans out to every configured channel, and one dead channel never silences the others.

- **Webhook** - a generic JSON `POST` to any URL you choose (an on-prem collector, an ntfy-style relay, your own script).
- **Chat** - a Slack or Teams incoming webhook. Set `chat.type` to `slack` or `teams`; the payload is formatted for that service.
- **Email** - SMTP through [nodemailer](https://nodemailer.com/). This is an optional dependency: an install without it still runs, and the email channel simply reports itself unavailable.

```json
"alerts": {
  "enabled": true,
  "webhook_url": "https://collector.example.com/hook",
  "chat": { "type": "slack", "webhook_url": "https://hooks.slack.com/services/XXX" },
  "email": {
    "smtp_host": "smtp.example.com",
    "smtp_port": 587,
    "smtp_secure": false,
    "smtp_user": "alerts@example.com",
    "smtp_password": "app-password",
    "from": "alerts@example.com",
    "to": ["oncall@example.com"]
  },
  "on": [],
  "min_interval_seconds": 60,
  "offline_grace_seconds": 60
}
```

- `enabled` is the master switch. With it off, nothing is sent.
- `on` is an allowlist of alert types to send. Leave it empty to send all of them.
- `min_interval_seconds` is a per-type de-dupe window, so a flapping lock cannot spam you (default 60).
- `offline_grace_seconds` is how long a lock or the controller must stay down before the sustained-offline alert fires (default 60), so a brief blip stays quiet.

The SMTP password field is named to match the config redaction rule, so `GET /api/config` never returns it in the clear.

### Alert types

Every alert carries a plain-language `severity` so a receiver can route it without knowing the type strings.

| Severity | Types |
|----------|-------|
| critical | `deadbolt_retract_failed`, `deadbolt_lock_failed`, `deadbolt_jammed`, `deadbolt_no_transport` |
| warning | `cascade_failed`, `deadbolt_lock_offline`, `deadbolt_low_battery`, `controller_disconnected` |
| info | `deadbolt_lock_online`, `controller_reconnected` |

The offline and online pairs are edge triggered: the down alert fires once after the grace window, and the matching recovery alert fires when the lock or controller comes back.

---

## SIP Phone Buttons (Auto-Lock)

Some intercoms and desk phones (for example Yealink) can fire a plain `GET` request from a DSS/programmable key but cannot send headers or a body. The `auto_lock` block maps each such button to a door and action so those phones can trigger the orchestrator directly.

```json
"auto_lock": {
  "shared_token": "a-long-random-string",
  "buttons": [
    { "id": "front-unlock", "door": "Front Door", "action": "unlock" }
  ]
}
```

The phone calls `http://ORCHESTRATOR_IP:3000/auto-lock/front-unlock?token=a-long-random-string`. Because these endpoints answer a bare GET, set a `shared_token` and keep it secret. The orchestrator never logs the URL or the token.

---

## Configuration Reference

Most settings can be edited from the dashboard, but everything lives in `config.json`. `config/config.example.json` is a minimal starting point; `config/config.deadbolt.example.json` shows a full deadbolt setup. The top-level blocks:

| Block | What it controls |
|-------|------------------|
| `server` | `port`, `host`, `admin_api_key`, and `start_at_login` (packaged app registers to start at login; default on, set `false` to opt out) |
| `unifi` | Controller `host`, `port` (12445), `token`, `verify_ssl`, and `user_sync_interval_minutes` |
| `event_source` | `mode` (`websocket` or `api_webhook`) and the settings for each: websocket reconnect interval, or the Alarm Manager webhook `endpoint_url`, `events`, `secret`, and `replay_window_seconds` |
| `resolver` | `strategy_order`, `unifi_group_to_group` (map UniFi group names to short logical names), and `manual_overrides` |
| `doors` | Discovered door name-to-ID mappings |
| `door_flows` | The one place automation lives: per door, its `triggers` and their `actions` (see [Configuring Doors](#configuring-doors-the-door-flow)) |
| `devices.zwave` | The Z-Wave transport and paired locks: `enabled`, `serial_path`, `cache_dir`, `security_keys` (never delete these after pairing), and per-lock settings under `locks` |
| `alerts` | Notifications and alerting (see [Notifications and Alerts](#notifications-and-alerts)) |
| `auto_lock` | SIP phone buttons (see [SIP Phone Buttons](#sip-phone-buttons-auto-lock)) |
| `backup` | `interval_days` and `max_backups` for automatic config backups |
| `logging` | `level`, `file_path`, `max_files`, `max_size` |
| `watchdog` | Monitors event-**source health**, not door activity, so a quiet-but-connected controller never triggers a restart. `inactivity_timeout_minutes` (0 disables): how long the source may stay unhealthy before a full app restart. `reconnect_after_minutes`: after this long unhealthy it first forces an in-process event-source reconnect (loses nothing), escalating to a restart only if that doesn't recover (defaults to half the timeout, capped at 5 min, if omitted). In webhook mode the window is arrival-based (re-register at the window, restart at twice the window). |
| `auto_sync` | Background user-group sync: `enabled` and `interval_seconds` |
| `self_trigger_prevention` | The marker the orchestrator stamps on its own unlocks so it never reacts to itself |

Each entry under `devices.zwave.locks` accepts, in addition to `name`, `manufacturer`, and `model_key`: `verify_timeout_ms`, `verify_retries`, `retry_backoff_ms`, `early_verify_read_ms`, `poll_minutes` (periodic bolt and battery refresh), `low_battery_pct` (the threshold for the low-battery alert), and `auto_relock`.

Secrets (the UniFi token, webhook and alert secrets, the SMTP password, the auto-lock token, the admin API key) are redacted from `GET /api/config`, and `PUT /api/config` strips the redaction placeholders back out on save, so editing config through the dashboard never overwrites a secret with its masked form.

---

## Troubleshooting

**"Cannot connect to Access Gateway"**
- Verify the controller IP is correct (not unifi.ui.com, the LAN IP)
- Verify port 12445 is accessible: `curl -k https://CONTROLLER_IP:12445/api/v1/developer/doors`
- Verify your API token is correct
- Check that the orchestrator machine and controller are on the same network/VLAN

**"No doors discovered"**
- The API token may not have the right permissions
- Try generating a new token in Access > Settings > General > Advanced

**"Events not appearing in the dashboard"**
- Check that Alarm Manager rules are set to **POST** (not GET)
- Verify the webhook URL points to the correct IP and port
- Check that the orchestrator machine's firewall allows inbound connections on port 3000

**"Door unlocked but wrong doors opened" or "No additional doors opened"**
- Check your group mappings match the exact names in UniFi Access
- Check that door names in your rules match the exact names shown in the device list
- Use the **Simulate Event** tool in Test Tools to debug rule evaluation

**"Infinite unlock loop"**
- The orchestrator includes self-trigger prevention. If you're seeing loops, check that the `extra` field is being passed through in your firmware version.
- Update your Access firmware to the latest version.

**Windows: "App won't start"**
- Check Windows Defender or antivirus isn't blocking it
- Try running as Administrator
- Check `%APPDATA%\unifi-access-orchestrator\logs\` for error details

**Linux: "Service won't start"**
- Check logs: `sudo journalctl -u unifi-access-orchestrator -f`
- Verify config.json is valid JSON: `node -e "JSON.parse(require('fs').readFileSync('/opt/unifi-access-orchestrator/config/config.json'))"`
- Check file permissions: `ls -la /opt/unifi-access-orchestrator/config/config.json`

---

## Building from Source

If you want to build the installers yourself instead of downloading from Releases:

### Prerequisites

- [Node.js](https://nodejs.org/) 22 or later (the app targets Node 22; see `engines` in `package.json`)
- [Git](https://git-scm.com/)

### Clone and Install

```bash
git clone https://github.com/ajbcloud/UniFi-Access-Orchestrator.git
cd UniFi-Access-Orchestrator
npm install
```

### Run in Development Mode

```bash
# Desktop app with hot reload
npm run dev

# Headless (web dashboard only, no Electron window)
npm run start:headless
```

### Build Installers

```bash
# Windows installer (.exe)
npm run build:win

# Linux (.AppImage + .deb)
npm run build:linux

# Raspberry Pi (.deb for ARM)
npm run build:pi

# macOS (.dmg)
npm run build:mac

# All platforms at once
npm run build:all
```

Built files appear in the `dist/` directory.

---

## API Reference

The orchestrator exposes these HTTP endpoints on its configured port (default 3000). The list has grown well past the core routes; the full set is grouped below.

**Core and events**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook` | Receives events from Alarm Manager or API webhook |
| GET | `/health` | Service status, door/user counts, event stats, memory usage |
| GET | `/api/events/stream` | Server-Sent Events stream for the real-time event feed |
| GET | `/api/events/history` | Recent events from memory |
| POST | `/reload` | Reload config.json without restarting the service |
| GET | `/api/diagnostics` | One-file support bundle: config (redacted), driver state, self-heal state, log tails |

**Config and automation**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Current running config (all secrets redacted) |
| PUT | `/api/config` | Save config changes to disk |
| GET | `/api/door-flows` | The door flows (automation) shape |
| PUT | `/api/door-flows` | Save door flow changes |
| GET | `/api/doors` | Discovered and configured doors |
| GET | `/api/users` | Cached users with group mappings |
| GET | `/api/groups/discovered` | Discovered UniFi groups and users |
| POST | `/api/sync` | Force re-sync of user groups from the UniFi API |
| GET | `/api/test-connection` | Test connectivity to the Access Gateway |
| GET | `/api/discover` | Scan the local network for UniFi controllers (rate-limited; keep behind `admin_api_key` in production) |
| GET | `/api/docs` | Serve this README for the in-app documentation view |

**Deadbolt and Z-Wave**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/devices` | Device inventory with live lock and link state |
| GET | `/api/deadbolt/serial-ports` | List serial ports (likely Z-Wave sticks flagged) |
| GET | `/api/deadbolt/catalog` | Supported lock models and their enroll/exclude steps |
| POST | `/api/deadbolt/pair/start` | Begin pairing (inclusion) |
| GET | `/api/deadbolt/pair/status` | Pairing progress |
| POST | `/api/deadbolt/pair/pin` | Submit the lock's S2 DSK PIN |
| POST | `/api/deadbolt/pair/cancel` | Cancel an in-progress pairing |
| POST | `/api/deadbolt/unpair` | Exclude a lock |
| GET | `/api/deadbolt/locks` | Saved locks and every node on the stick |
| DELETE | `/api/deadbolt/locks/:lock_id` | Remove a saved lock |
| POST | `/api/deadbolt/control` | Manually lock or unlock |
| POST | `/api/deadbolt/auto-relock` | Set a lock's auto-relock behavior |
| POST | `/api/deadbolt/health-check` | Ping, RTT, RSSI, route, and a lifeline rating |
| POST | `/api/deadbolt/reinterview` | Re-interview / heal a node |
| GET | `/api/deadbolt/user-codes` | Keypad codes on a lock |
| POST | `/api/deadbolt/user-codes` | Write a keypad code |
| DELETE | `/api/deadbolt/user-codes/:slot` | Remove a code slot |
| POST | `/api/deadbolt/user-codes/rewrite` | Rewrite drifted code slots |
| GET | `/api/deadbolt/keypad-users` | Per-user keypad status across locks |
| POST | `/api/deadbolt/keypad-users` | Set a user's one PIN across eligible locks |
| DELETE | `/api/deadbolt/keypad-users/:user_id` | Remove a user's keypad access |

**Backups**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/backups` | List config backups and backup settings |
| POST | `/api/backups` | Create a config backup now |
| POST | `/api/backups/restore` | Restore config from a backup |
| GET | `/api/backups/:filename` | Download a specific backup |

**Test tools and capture**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/test/unlock/:door` | Remotely unlock a door by name |
| POST | `/test/event` | Simulate an event through the rules engine |
| POST | `/test/preflight` | Preflight connectivity and permission checks |
| POST | `/test/simulate-rule` | Dry-run a payload against your door flows |
| POST | `/api/capture/start` | Begin recording raw events for tuning |
| POST | `/api/capture/stop` | Stop recording |
| POST | `/api/capture/label` | Label the current capture |
| GET | `/api/capture` | Inspect captured raw events |

**SIP phone buttons**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auto-lock/:buttonId` | Bare-GET trigger for SIP phone DSS keys (optional `?token=`) |

### API Security

For production deployments, configure these optional controls in `config.json`:

- `server.admin_api_key`: Requires `x-api-key` header for all `/api/*`, `/test/*`, and `/reload` routes (query-string API keys are intentionally not accepted).
- `event_source.api_webhook.secret`: Requires an `x-orchestrator-signature` header containing `sha256=<hmac>` of the raw webhook body, signed with your shared secret.

If these values are blank, the routes remain unauthenticated for local/lab setups.

---

## Project Structure

```text
unifi-access-orchestrator/
  assets/
    icon.svg                    App icon
  config/
    config.example.json         Minimal example configuration
    config.deadbolt.example.json Full example with Z-Wave deadbolts and alerts
  docs/
    pc-bringup-runbook.md       Hands-on hardware bring-up checklist for the deadbolt
    app-review-2026-07.md       Historical engineering review (self-healing work)
    orchestrator-addon-plan.md  Historical design record for the deadbolt add-on
    orchestrator-addon-handoff.md Historical build/test handoff for the add-on
  electron/
    main.js                     Desktop app: window, tray, config paths, start-at-login
  public/
    index.html                  Dashboard UI + setup wizard (single file, no build step)
  src/
    index.js                    Express server, all API routes, SSE stream, wiring
    unifi-client.js             UniFi Access API client (REST + WebSocket)
    resolver.js                 Resolves user IDs to logical group names
    rules-engine.js             Processes events and decides which doors to unlock
    door-flows.js               The door-centric automation shape (triggers/actions)
    deadbolt-controller.js      Deadbolt event-to-action logic (retract, cascade, relock)
    deadbolt-rules.js           Legacy deadbolt-rule shape helpers and migration
    keypad-users.js             One-PIN-per-user planning across per-lock code storage
    user-code-sync.js           Cross-lock UniFi PIN sync decisions
    access-gating.js            Decides which users get a keypad code on which lock
    notifier.js                 Outbound alerting (webhook, Slack/Teams, email)
    alert-monitors.js           Sustained-offline monitors for connectivity alerts
    security.js                 Security helpers and secret redaction
    backup.js                   Timestamped config backups and pruning
    config-sync.js              Detects local config and upstream controller changes
    capture.js                  Labeled raw-event recorder for payload tuning
    lock-cleanup.js             Removes unpaired lock config and its automation edges
    logger.js                   Log management with daily rotation
    validate.js                 CLI tool for testing connectivity and discovering doors
    drivers/
      lock-driver.js            Provider-agnostic lock driver contract
      fake-lock.js              In-memory lock for tests and dry-run
      lock-catalog.js           Lock model catalog with per-model enroll/exclude steps
      zwave-manager.js          Sole owner of the zwave-js driver and serial port
      zwave-lock.js             Z-Wave deadbolt adapter (Door Lock + Notification CC)
      zwave-pairing.js          Inclusion/exclusion and S2/S0 security handling
      zwave-keys.js             S2/S0 security key management
      zwave-crypto-shim.js      AES-CCM shim for Electron/BoringSSL S2 inclusion
  scripts/
    setup-pi.sh                 Automated Linux/Pi deployment script
  .gitignore
  LICENSE
  package.json
  README.md
```

`zwave-js` and `nodemailer` are optional dependencies, so an install that does not use deadbolts or email alerts still boots normally.

---

## Contributing

Contributions welcome. This project was built for a specific multi-tenant building but is designed to work with any UniFi Access deployment.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -am 'Add my feature'`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

---

## License

Source Available License. See [LICENSE](LICENSE) for details.

Built by [AJBCloud](https://github.com/ajbcloud).
