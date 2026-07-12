/**
 * In-app auto-update via electron-updater and GitHub Releases.
 *
 * Checks for a newer published release on launch (packaged builds only) and on
 * demand from Help > Check for Updates, downloads the installer in the
 * background, and prompts the user to restart to install. The prompt is a
 * native modal, so the user never leaves the app.
 *
 * electron-updater is required lazily so a dev run (or a build without the
 * dependency) never crashes the main process just by loading this module.
 */

const { app, dialog } = require('electron');

let autoUpdater = null;
let getWin = () => null;          // supplied by main so dialogs attach to the window
let markQuitting = () => {};      // lets main set isQuitting before quitAndInstall
let manualCheck = false;          // whether the in-flight check was user-initiated
let wired = false;

function load() {
  if (autoUpdater) return autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.error('electron-updater unavailable:', e.message);
    autoUpdater = null;
  }
  return autoUpdater;
}

function wireEvents() {
  if (wired || !autoUpdater) return;
  wired = true;

  autoUpdater.autoDownload = true;          // fetch in the background once found
  autoUpdater.autoInstallOnAppQuit = true;  // also install on a normal quit
  autoUpdater.logger = console;

  autoUpdater.on('update-available', (info) => {
    console.log(`Update available: ${info && info.version}. Downloading in the background.`);
  });

  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox(getWin(), {
      type: 'info',
      title: 'No Updates',
      message: 'You are on the latest version.',
      detail: `Version ${app.getVersion()} is current.`
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err == null ? 'unknown' : (err.stack || err).toString());
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox(getWin(), {
      type: 'warning',
      title: 'Update Check Failed',
      message: 'Could not check for updates right now.',
      detail: 'Please try again later, or download the latest release from GitHub.'
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(getWin(), {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: `Version ${info && info.version} has been downloaded.`,
      detail: 'Restart now to install it. Your configuration is kept.'
    }).then((result) => {
      if (result.response === 0) {
        markQuitting();               // so the window close handler does not veto the quit
        autoUpdater.quitAndInstall();
      }
    }).catch(() => { /* dialog dismissed */ });
  });
}

// Called once from main after the window exists. No-op in dev (there is no
// update feed) so running from source never triggers a check.
function initAutoUpdater({ getMainWindow, setQuitting } = {}) {
  if (typeof getMainWindow === 'function') getWin = getMainWindow;
  if (typeof setQuitting === 'function') markQuitting = setQuitting;
  if (!app.isPackaged) return;
  const u = load();
  if (!u) return;
  wireEvents();
  manualCheck = false;
  u.checkForUpdates().catch((e) => console.error('Initial update check failed:', e.message));
}

// Wired to Help > Check for Updates. Gives explicit feedback in every outcome.
function checkForUpdatesManual() {
  const win = getWin();
  if (!app.isPackaged) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Updates',
      message: 'Update checks run in the installed app only.'
    });
    return;
  }
  const u = load();
  if (!u) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Updates',
      message: 'The updater is unavailable in this build.'
    });
    return;
  }
  wireEvents();
  manualCheck = true;
  u.checkForUpdates().catch((e) => {
    manualCheck = false;
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Update Check Failed',
      message: 'Could not check for updates right now.',
      detail: e.message
    });
  });
}

module.exports = { initAutoUpdater, checkForUpdatesManual };
