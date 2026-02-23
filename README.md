# UniFi Access Orchestrator

Automate multi-door unlocks for [Ubiquiti UniFi Access](https://ui.com/door-access). When someone badges in at one door, automatically unlock additional doors based on who they are. When a visitor is buzzed in through the intercom, unlock doors based on which tenant answered.

Built for multi-tenant commercial buildings where different tenants need different door sequences.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Option A: Windows Desktop App](#option-a-windows-desktop-app)
- [Option B: Linux / Raspberry Pi](#option-b-linux--raspberry-pi)
- [Configuring Unlock Rules](#configuring-unlock-rules)
- [Setting Up Alarm Manager Webhooks](#setting-up-alarm-manager-webhooks)
- [Testing Your Setup](#testing-your-setup)
- [Dashboard Guide](#dashboard-guide)
- [Troubleshooting](#troubleshooting)
- [Building from Source](#building-from-source)
- [API Reference](#api-reference)
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
   - Go to **Access > Settings > General > scroll down to Advanced > API Token**
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

### Step 6: Configure Your Rules

See [Configuring Unlock Rules](#configuring-unlock-rules) below.

### Step 7: Set Up Webhooks

See [Setting Up Alarm Manager Webhooks](#setting-up-alarm-manager-webhooks) below. Use this PC's IP address for the webhook URL.

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
cd unifi-access-orchestrator
```

### Step 5: Run the Setup Script

```bash
sudo bash scripts/setup-pi.sh
```

This script does everything automatically:
- Updates system packages
- Installs Node.js 20
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

### Step 9: Configure Your Rules

See [Configuring Unlock Rules](#configuring-unlock-rules) below. You can do this from the dashboard in your browser or by editing the config file directly.

### Step 10: Set Up Webhooks

See [Setting Up Alarm Manager Webhooks](#setting-up-alarm-manager-webhooks) below. Use the Linux device's IP address for the webhook URL.

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

## Configuring Unlock Rules

After the orchestrator is running and connected to your controller, you need to tell it what to do when events happen.

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

### Step 3: Define NFC/Tap Rules

Set which door is the trigger, and what happens for each group:

```json
"unlock_rules": {
  "trigger_location": "Front Door",
  "group_actions": {
    "office": { "unlock": ["Suite 100"] },
    "suite_200": { "unlock": ["Elevator"] },
    "management": { "unlock": ["Suite 100", "Suite 200", "Elevator"] }
  },
  "default_action": { "unlock": [] }
}
```

This means: when someone in the "office" group badges in at Front Door, also unlock Suite 100. Management gets everything. Unknown groups get nothing.

### Step 4: Define Doorbell Rules

Set what happens when a visitor is buzzed in:

```json
"doorbell_rules": {
  "trigger_location": "Front Door",
  "trigger_reason_code": 107,
  "group_actions": {
    "office": { "unlock": ["Suite 100"] },
    "suite_200": { "unlock": ["Elevator"] },
    "management": { "unlock": ["Suite 100", "Suite 200", "Elevator"] }
  },
  "viewer_to_group": {
    "Office Viewer": "office",
    "Suite 200 Viewer": "suite_200"
  },
  "default_action": { "unlock": ["Elevator"] }
}
```

The `viewer_to_group` section is a fallback. If the orchestrator can't identify who answered the doorbell by their user account, it checks which Intercom Viewer device was involved and maps that to a group.

### Step 5: Reload

After editing config, apply the changes:

- **Dashboard:** Click the **Reload Service** button on the Configuration tab
- **Command line:** `sudo systemctl restart unifi-access-orchestrator`
- **API:** `curl -X POST http://DEVICE_IP:3000/reload`

---

## Setting Up Alarm Manager Webhooks

The orchestrator needs to receive events from UniFi Access. The simplest way is through Alarm Manager webhooks.

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

The dashboard has four tabs:

**Dashboard** - Overview showing door count, user count, events received, unlocks triggered, last event details, and system info (memory, uptime, event source mode).

**Live Events** - Real-time scrolling feed of every event. Each row shows the timestamp, event type (color-coded), who triggered it, which door, what the orchestrator did, and whether it succeeded. Events stream in automatically via Server-Sent Events.

**Configuration** - Shows your door mappings, user groups, NFC tap rules, doorbell visitor rules, and event source mode. Buttons to rediscover doors and reload the service.

**Test Tools** - Click any door to test-unlock it. Simulate events with configurable parameters. Quick action buttons for force sync, reload, and health check.

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

- [Node.js](https://nodejs.org/) 18 or later
- [Git](https://git-scm.com/)

### Clone and Install

```bash
git clone https://github.com/ajbcloud/UniFi-Access-Orchestrator.git
cd unifi-access-orchestrator
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

The orchestrator exposes these HTTP endpoints on its configured port (default 3000):

| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook` | Receives events from Alarm Manager or API webhook |
| GET | `/health` | Service status, door/user counts, event stats, memory usage |
| GET | `/api/events/stream` | Server-Sent Events stream for real-time event feed |
| GET | `/api/events/history` | Last 200 events from memory |
| POST | `/test/unlock/:door` | Remotely unlock a door by name |
| POST | `/test/event` | Simulate an event through the rules engine |
| POST | `/reload` | Reload config.json without restarting the service |
| GET | `/api/config` | Current running config (API token redacted) |
| PUT | `/api/config` | Save config changes to disk |
| GET | `/api/doors` | All discovered doors with IDs |
| GET | `/api/users` | All cached users with group mappings |
| POST | `/api/sync` | Force re-sync of user groups from the UniFi API |

---

## Project Structure

```
unifi-access-orchestrator/
  assets/
    icon.svg                App icon
  config/
    config.example.json     Example configuration (edit and rename to config.json)
  electron/
    main.js                 Desktop app: window management, tray, config paths
  public/
    index.html              Dashboard UI + setup wizard (single file, no build step)
  src/
    index.js                Express server, API routes, SSE event stream
    unifi-client.js         UniFi Access API client (doors, users, webhooks, WebSocket)
    resolver.js             Resolves user IDs to group names
    rules-engine.js         Processes events and decides which doors to unlock
    logger.js               Log management with daily rotation
    validate.js             CLI tool for testing connectivity and discovering doors
  scripts/
    setup-pi.sh             Automated Linux/Pi deployment script
  .gitignore
  LICENSE
  package.json
  README.md
```

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

Built by [AJBCloud](https://qitsolutions.com).
