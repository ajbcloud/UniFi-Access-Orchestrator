/**
 * Electron Main Process
 * 
 * Manages the application window, custom menu bar, system tray,
 * middleware lifecycle, and platform-specific behaviors.
 */

const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getConfigDir() {
  return app.getPath('userData');
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

function getLogDir() {
  return path.join(getConfigDir(), 'logs');
}

function ensureConfig() {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  const logDir = getLogDir();

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

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
        event_source: { mode: 'alarm_manager' },
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
      contextIsolation: true
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
              // Navigate to setup wizard
              mainWindow.webContents.executeJavaScript('showSetupWizard && showSetupWizard()');
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
              mainWindow.webContents.executeJavaScript('showSetupWizard && showSetupWizard(); setTimeout(() => runDiscovery && runDiscovery(), 300)');
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
              mainWindow.webContents.executeJavaScript('showSetupWizard && showSetupWizard()');
            }
          }
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
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.executeJavaScript('showSetupWizard && showSetupWizard()'); }
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

  return nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4, 0), { width: 16, height: 16 });
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

app.on('ready', async () => {
  const configExists = ensureConfig();

  createAppMenu();
  await startOrchestrator();
  await new Promise(resolve => setTimeout(resolve, 1000));

  createWindow();
  createTray();

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
