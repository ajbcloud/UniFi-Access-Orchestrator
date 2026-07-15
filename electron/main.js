/**
 * Electron Main Process
 * 
 * Manages the application window, custom menu bar, system tray,
 * middleware lifecycle, and platform-specific behaviors.
 */

const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const updater = require('./updater');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getConfigDir() {
  return app.getPath('userData');
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

// Best-effort config read for pre-boot decisions (start-at-login). Never
// throws: a missing or corrupt config just means defaults apply.
function readConfigSafe() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch (e) {
    return null;
  }
}

function getLogDir() {
  return path.join(getConfigDir(), 'logs');
}

function getBackupDir() {
  return path.join(getConfigDir(), 'backups');
}

function ensureConfig() {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  const logDir = getLogDir();

  const backupDir = getBackupDir();

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  if (!fs.existsSync(configPath)) {
    const candidates = [
      path.join(app.getAppPath(), 'config', 'config.example.json'),
      path.join(process.resourcesPath || '', 'config', 'config.example.json'),
      path.join(__dirname, '..', 'config', 'config.example.json')
    ];

    let copied = false;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        fs.copyFileSync(candidate, configPath);
        copied = true;
        break;
      }
    }

    if (!copied) {
      const defaultConfig = {
        server: { port: 3000, host: '0.0.0.0' },
        unifi: { host: '', port: 12445, token: '', verify_ssl: false, user_sync_interval_minutes: 5 },
        event_source: { mode: 'websocket' },
        resolver: { strategy_order: ['api_group', 'manual'], unifi_group_to_group: {}, manual_overrides: {} },
        doors: {},
        unlock_rules: { trigger_location: '', group_actions: {}, default_action: { unlock: [] } },
        doorbell_rules: { trigger_location: '', trigger_reason_code: 107, group_actions: {}, viewer_to_group: {}, default_action: { unlock: [] } },
        self_trigger_prevention: { marker_key: 'source', marker_value: 'middleware' },
        logging: { level: 'info', file_path: path.join(logDir, 'access.log'), max_files: '30d', max_size: '10m' }
      };
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    }

    return false;
  }

  return true;
}

function patchConfigPath() {
  process.env.MIDDLEWARE_CONFIG_PATH = getConfigPath();
  process.env.LOG_DIR = getLogDir();
  process.env.BACKUP_DIR = getBackupDir();
}

// Safe HTTP call for menu actions - catches all errors gracefully
function menuApiCall(urlPath, method, onSuccess) {
  const http = require('http');
  const req = http.request({
    hostname: '127.0.0.1',
    port: servicePort,
    path: urlPath,
    method: method || 'POST',
    timeout: 5000
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => { if (onSuccess) onSuccess(data); });
  });
  req.on('error', (err) => {
    console.error(`Menu API call failed (${urlPath}): ${err.message}`);
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: 'Action failed',
        detail: `Could not reach the orchestrator service.\n\n${err.message}`
      });
    }
  });
  req.on('timeout', () => { req.destroy(); });
  req.end();
}

// ---------------------------------------------------------------------------
// Renderer bridge (answers electron/preload.js over synchronous IPC)
//
// The dashboard authenticates to its own local server with the admin API key
// the server generates on first boot. The SPA cannot fetch the key over HTTP
// (it is both required and redacted by the API), so the preload asks main,
// and main reads config.json FRESH on every call so reloads, backup restores,
// and the Reset Configuration relaunch always hand out the current key.
// Every path must set event.returnValue: an unanswered sync IPC would hang
// the renderer.
// ---------------------------------------------------------------------------

let wasFirstRun = false;

ipcMain.on('orchestrator:get-admin-api-key', (event) => {
  try {
    const cfg = JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    event.returnValue = (cfg.server && cfg.server.admin_api_key) || '';
  } catch (e) {
    event.returnValue = '';
  }
});

ipcMain.on('orchestrator:is-first-run', (event) => {
  event.returnValue = wasFirstRun;
});

// ---------------------------------------------------------------------------
// Orchestrator lifecycle
// ---------------------------------------------------------------------------

let orchestratorStarted = false;
let servicePort = 3000;

async function startOrchestrator() {
  if (orchestratorStarted) return;

  patchConfigPath();

  const configPath = getConfigPath();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  servicePort = config.server?.port || 3000;

  if (config.logging) {
    config.logging.file_path = path.join(getLogDir(), 'access.log');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  process.env.MIDDLEWARE_CONFIG_PATH = configPath;

  try {
    const middleware = require(path.join(app.getAppPath(), 'src', 'index.js'));
    if (middleware.setWatchdogRestartCallback) {
      middleware.setWatchdogRestartCallback(() => {
        console.log('Watchdog triggered app relaunch');
        app.relaunch();
        isQuitting = true;
        app.quit();
      });
    }
    await middleware.start();
    orchestratorStarted = true;
    console.log(`Orchestrator started on port ${servicePort}`);
  } catch (err) {
    console.error('Failed to start middleware:', err.message);
    try {
      const express = require('express');
      const minApp = express();
      minApp.use(express.json());
      minApp.use(express.static(path.join(app.getAppPath(), 'public')));
      minApp.get('/health', (req, res) => res.json({ status: 'error', error: err.message }));
      minApp.get('/api/config', (req, res) => {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (cfg.unifi?.token) cfg.unifi.token = '***REDACTED***';
        res.json(cfg);
      });
      minApp.put('/api/config', (req, res) => {
        const current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const safeKeys = ['unlock_rules', 'doorbell_rules', 'event_source', 'logging', 'server', 'unifi', 'resolver', 'doors'];
        for (const key of safeKeys) {
          if (req.body[key] !== undefined) current[key] = req.body[key];
        }
        fs.writeFileSync(configPath, JSON.stringify(current, null, 2));
        res.json({ status: 'saved' });
      });
      minApp.post('/reload', (req, res) => {
        res.json({ status: 'restart_required', note: 'Please restart the application to apply changes.' });
      });
      minApp.get('*', (req, res) => res.sendFile(path.join(app.getAppPath(), 'public', 'index.html')));
      minApp.listen(servicePort, '0.0.0.0', () => {
        console.log(`Fallback GUI server on port ${servicePort}`);
      });
    } catch (fallbackErr) {
      dialog.showErrorBox('Startup Error', `Could not start:\n\n${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'UniFi Access Orchestrator',
    backgroundColor: '#111318',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadURL(`http://localhost:${servicePort}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------------------
// App Menu
// ---------------------------------------------------------------------------

function createAppMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'Connection Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
              // Jump straight to the connect step (the controller screen)
              mainWindow.webContents.executeJavaScript("showSetupWizard && showSetupWizard('connect')");
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Open Config File',
          click: () => { shell.openPath(getConfigPath()); }
        },
        {
          label: 'Open Config Folder',
          click: () => { shell.openPath(getConfigDir()); }
        },
        {
          label: 'Open Log Folder',
          click: () => { shell.openPath(getLogDir()); }
        },
        {
          label: 'Open Backups Folder',
          click: () => { shell.openPath(getBackupDir()); }
        },
        { type: 'separator' },
        {
          label: 'Backup Config Now',
          click: () => {
            menuApiCall('/api/backups', 'POST', () => {
              dialog.showMessageBox(mainWindow, { type: 'info', title: 'Backup', message: 'Configuration backup created successfully.', detail: `Backups are saved in:\n${getBackupDir()}` });
            });
          }
        },
        { type: 'separator' },
        {
          label: 'Open in Browser',
          accelerator: 'CmdOrCtrl+B',
          click: () => { shell.openExternal(`http://localhost:${servicePort}`); }
        },
        { type: 'separator' },
        {
          label: 'Reset Configuration',
          click: async () => {
            const result = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              buttons: ['Cancel', 'Reset'],
              defaultId: 0,
              title: 'Reset Configuration',
              message: 'This will delete your configuration and restart with the setup wizard.',
              detail: 'Your unlock rules, door mappings, and connection settings will be removed. This cannot be undone.'
            });
            if (result.response === 1) {
              try {
                fs.unlinkSync(getConfigPath());
                app.relaunch();
                isQuitting = true;
                app.quit();
              } catch (e) {
                dialog.showErrorBox('Error', `Failed to reset: ${e.message}`);
              }
            }
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } }
      ]
    },

    // View menu
    {
      label: 'View',
      submenu: [
        {
          label: 'Dashboard',
          accelerator: 'CmdOrCtrl+1',
          click: () => navigateTo('dashboard')
        },
        {
          label: 'Live Events',
          accelerator: 'CmdOrCtrl+2',
          click: () => navigateTo('events')
        },
        {
          label: 'Configuration',
          accelerator: 'CmdOrCtrl+3',
          click: () => navigateTo('config')
        },
        {
          label: 'Test Tools',
          accelerator: 'CmdOrCtrl+4',
          click: () => navigateTo('tools')
        },
        { type: 'separator' },
        { role: 'reload', label: 'Refresh Page' },
        { role: 'toggleDevTools', label: 'Developer Tools' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' }
      ]
    },

    // Tools menu
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Force User Sync',
          click: () => { menuApiCall('/api/sync', 'POST', (data) => {
            try { const r = JSON.parse(data); dialog.showMessageBox(mainWindow, { type: 'info', message: `Synced ${r.users_mapped || 0} users.` }); }
            catch { dialog.showMessageBox(mainWindow, { type: 'info', message: 'Sync complete.' }); }
          }); }
        },
        {
          label: 'Reload Service',
          click: () => { menuApiCall('/reload', 'POST', () => {
            dialog.showMessageBox(mainWindow, { type: 'info', message: 'Service reloaded.' });
            if (mainWindow) mainWindow.webContents.reload();
          }); }
        },
        {
          label: 'Rediscover Doors',
          click: () => { menuApiCall('/reload', 'POST', () => {
            if (mainWindow) { navigateTo('config'); mainWindow.webContents.reload(); }
          }); }
        },
        { type: 'separator' },
        {
          label: 'Test Connection',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
              mainWindow.webContents.executeJavaScript(`
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
                document.querySelector('[data-page="tools"]').classList.add('active');
                document.getElementById('tools').classList.add('active');
                document.getElementById('setup').style.display = 'none';
                document.getElementById('tabBar').style.display = 'flex';
                setTimeout(() => runConnectivityTest && runConnectivityTest(), 300);
              `);
            }
          }
        },
        {
          label: 'Scan for Controllers',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
              mainWindow.webContents.executeJavaScript("showSetupWizard && showSetupWizard('connect'); setTimeout(() => runDiscovery && runDiscovery(), 300)");
            }
          }
        }
      ]
    },

    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          accelerator: 'F1',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
              // Navigate to the in-app docs page
              mainWindow.webContents.executeJavaScript('showDocs && showDocs()');
            }
          }
        },
        {
          label: 'Getting Started',
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
              // Start the guided wizard from the welcome step
              mainWindow.webContents.executeJavaScript("showSetupWizard && showSetupWizard('welcome')");
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Check for Updates...',
          click: () => { updater.checkForUpdatesManual(); }
        },
        { type: 'separator' },
        {
          label: 'GitHub Repository',
          click: () => { shell.openExternal('https://github.com/ajbcloud/UniFi-Access-Orchestrator'); }
        },
        {
          label: 'Report an Issue',
          click: () => { shell.openExternal('https://github.com/ajbcloud/UniFi-Access-Orchestrator/issues'); }
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About UniFi Access Orchestrator',
              message: 'UniFi Access Orchestrator',
              detail: `Version ${app.getVersion()}\n\nMulti-door unlock automation for UniFi Access.\n\nBuilt by AJBCloud\nhttps://qitsolutions.com`
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function navigateTo(page) {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.executeJavaScript(`
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelector('[data-page="${page}"]').classList.add('active');
      document.getElementById('${page}').classList.add('active');
      document.getElementById('setup').style.display = 'none';
      document.getElementById('tabBar').style.display = 'flex';
    `);
  }
}

// ---------------------------------------------------------------------------
// System Tray
// ---------------------------------------------------------------------------

function createTray() {
  const iconPath = getIconPath();
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else createWindow();
      }
    },
    { label: 'Open in Browser', click: () => { shell.openExternal(`http://localhost:${servicePort}`); } },
    { type: 'separator' },
    { label: 'Connection Settings', click: () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.executeJavaScript("showSetupWizard && showSetupWizard('connect')"); }
    }},
    { label: 'Open Config Folder', click: () => { shell.openPath(getConfigDir()); } },
    { label: 'Open Log Folder', click: () => { shell.openPath(getLogDir()); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('UniFi Access Orchestrator');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

function getIconPath() {
  // Use dedicated tray icon (32x32, high contrast, transparent background)
  const trayCandidates = [
    path.join(app.getAppPath(), 'assets', 'tray-icon.png'),
    path.join(__dirname, '..', 'assets', 'tray-icon.png')
  ];
  for (const candidate of trayCandidates) {
    if (fs.existsSync(candidate)) {
      return nativeImage.createFromPath(candidate);
    }
  }

  // Fall back to main icon resized
  const iconCandidates = [
    path.join(app.getAppPath(), 'assets', 'icon.png'),
    path.join(__dirname, '..', 'assets', 'icon.png')
  ];
  for (const candidate of iconCandidates) {
    if (fs.existsSync(candidate)) {
      return nativeImage.createFromPath(candidate).resize({ width: 16, height: 16 });
    }
  }

  // createFromBitmap is the correct API for a raw RGBA buffer. createFromBuffer
  // expects ENCODED image data (PNG/JPEG) and yields an empty image for raw
  // bytes on modern Electron, which left the tray icon blank whenever the
  // packaged app fell through to this path.
  return nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 0), { width: 16, height: 16 });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let healthFailCount = 0;
let healthWatchdog = null;

function startHealthWatchdog() {
  const http = require('http');
  // Surface a stall in the title without pretending the controller dropped:
  // "Not responding" means THIS app's server is slow/hung, "Disconnected"
  // means the server answered and reported the UniFi link down.
  const setStalledTitle = () => {
    if (mainWindow && healthFailCount >= 2) {
      mainWindow.setTitle('UniFi Access Orchestrator — Not responding');
    }
  };
  healthWatchdog = setInterval(() => {
    // 15s, not 5s: a long Z-Wave verify on an S0 lock can stall the service's
    // event loop past 5s, and those false timeouts both froze the title and
    // fed the relaunch counter.
    const req = http.get(`http://127.0.0.1:${servicePort}/health`, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const h = JSON.parse(data);
          healthFailCount = 0;
          if (mainWindow) {
            // Keep this mapping identical to the in-app status pill
            // (updateStatus in public/index.html) so the window title and the
            // pill never contradict each other.
            const cs = h.unifi?.connection_state || 'unknown';
            const label = cs === 'connected'
              ? 'Online'
              : (cs === 'reconnecting' || cs === 'connecting') ? 'Reconnecting...' : 'Disconnected';
            mainWindow.setTitle(`UniFi Access Orchestrator — ${label}`);
          }
        } catch { healthFailCount++; setStalledTitle(); }
      });
    });
    // Only a hard connection error counts toward the relaunch: the service
    // process is genuinely gone/unreachable. A slow response (timeout) or a
    // garbled body must never restart a working service mid-operation.
    // (destroy() after a timeout can surface as an 'error' too; the flag
    // keeps that from masquerading as a dead service.)
    let timedOut = false;
    let counted = false;
    const countFailure = () => {
      if (counted) return; // one failure per probe, however many events fire
      counted = true;
      healthFailCount++;
      setStalledTitle();
    };
    req.on('error', () => {
      countFailure();
      if (timedOut) return;
      if (healthFailCount >= 3) {
        console.error(`Health watchdog: ${healthFailCount} consecutive failures. Relaunching...`);
        app.relaunch();
        isQuitting = true;
        app.quit();
      }
    });
    req.on('timeout', () => { timedOut = true; countFailure(); req.destroy(); });
  }, 30000);
}

app.on('ready', async () => {
  const configExists = ensureConfig();
  wasFirstRun = !configExists; // exposed to the renderer via the preload bridge

  // Self-healing, layer 0: this box lives unattended in a rack. After a power
  // outage Windows/macOS boot to the login screen or desktop with nothing
  // running unless the app registers itself to start. Packaged builds opt in
  // by default; set server.start_at_login=false in config.json to opt out.
  // (Dev runs skip it so a checkout never installs itself into login items.)
  try {
    if (app.isPackaged) {
      const cfg = readConfigSafe();
      const wantAutostart = !(cfg && cfg.server && cfg.server.start_at_login === false);
      const current = app.getLoginItemSettings();
      if (current.openAtLogin !== wantAutostart) {
        app.setLoginItemSettings({ openAtLogin: wantAutostart });
        console.log(`Start at login ${wantAutostart ? 'enabled' : 'disabled'}`);
      }
    }
  } catch (e) {
    console.warn('Could not update start-at-login setting:', e.message);
  }

  createAppMenu();
  await startOrchestrator();
  await new Promise(resolve => setTimeout(resolve, 1000));

  createWindow();
  createTray();
  startHealthWatchdog();

  // Check GitHub for a newer release and offer an in-app restart-to-install.
  // No-op in an unpackaged dev run.
  updater.initAutoUpdater({
    getMainWindow: () => mainWindow,
    setQuitting: () => { isQuitting = true; }
  });

  if (!configExists) {
    console.log('First run detected. Config created at:', getConfigPath());
  }
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') { /* stay in dock */ }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
  else mainWindow.show();
});
