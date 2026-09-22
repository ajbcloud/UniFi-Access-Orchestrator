/**
 * Desktop update backend: electron-updater plugged into the shared update
 * checker in src/update-checker.js.
 *
 * The checker owns the schedule and the state the dashboard renders (the
 * Upgrade banner). This module only answers two questions for it on the
 * packaged desktop app: "is there a newer release on GitHub Releases?" (via
 * electron-updater's signed feed, latest*.yml) and "install it" (download in
 * the background, then quit and run the installer when the user clicks
 * Upgrade). Progress flows back through report() so the banner can show a
 * percentage and a Restart button.
 *
 * Platform notes:
 *   - Windows (NSIS) and Linux (AppImage/deb) install in place.
 *   - macOS builds are not code signed, and electron-updater refuses to
 *     update an unsigned app, so the banner offers a Download button instead.
 *   - Unpackaged dev runs have no feed; checks are disabled entirely.
 *
 * electron-updater is required lazily so a dev run (or a build without the
 * dependency) never crashes the main process just by loading this module.
 */

const { app, dialog, shell } = require('electron');

let autoUpdater = null;
let getWin = () => null;          // supplied by main so dialogs attach to the window
let markQuitting = () => {};      // lets main set isQuitting before quitAndInstall
let getChecker = () => null;      // the service's UpdateChecker, for the Help menu
let report = () => {};            // checker.reportInstall, attached by setBackend
let wired = false;

// Download bookkeeping shared between the events and install().
let phase = 'idle';               // idle | downloading | ready | installing
let percent = null;
let lastProgressEmit = 0;
let installRequested = false;
let pendingInfo = null;           // updateInfo from the last positive check

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

function releaseUrlFor(version) {
  return `https://github.com/ajbcloud/UniFi-Access-Orchestrator/releases/tag/v${String(version).replace(/^v/, '')}`;
}

function notesToText(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) return notes.map((n) => (n && n.note) || '').join('\n');
  return '';
}

function restartToInstall() {
  phase = 'installing';
  report({ state: 'installing', progress: 100, detail: 'Restarting to install the update...' });
  markQuitting();               // so the window close handler does not veto the quit
  // Give the HTTP response and the SSE push a moment to reach the dashboard.
  setTimeout(() => {
    try { autoUpdater.quitAndInstall(false, true); }
    catch (e) {
      phase = 'ready';
      report({ state: 'failed', error: `Could not start the installer: ${e.message}` });
    }
  }, 600);
}

function wireEvents() {
  if (wired || !autoUpdater) return;
  wired = true;

  autoUpdater.autoDownload = true;          // fetch in the background once found
  autoUpdater.autoInstallOnAppQuit = true;  // also install on a normal quit
  autoUpdater.logger = console;

  autoUpdater.on('update-available', (info) => {
    pendingInfo = info || pendingInfo;
    if (phase === 'idle') {
      phase = 'downloading';
      percent = 0;
      report({ state: 'downloading', progress: 0, detail: `Downloading v${info && info.version} in the background...` });
    }
    console.log(`Update available: ${info && info.version}. Downloading in the background.`);
  });

  autoUpdater.on('download-progress', (p) => {
    percent = Math.max(0, Math.min(100, Math.round((p && p.percent) || 0)));
    phase = 'downloading';
    const now = Date.now();
    if (now - lastProgressEmit < 700 && percent < 100) return; // throttle the SSE pushes
    lastProgressEmit = now;
    const mb = p && p.transferred ? ` (${(p.transferred / 1048576).toFixed(0)} of ${(p.total / 1048576).toFixed(0)} MB)` : '';
    report({ state: 'downloading', progress: percent, detail: `Downloading${mb}` });
  });

  autoUpdater.on('update-downloaded', (info) => {
    pendingInfo = info || pendingInfo;
    phase = 'ready';
    percent = 100;
    if (installRequested) {
      installRequested = false;
      restartToInstall();
      return;
    }
    report({ state: 'ready', progress: 100, detail: `v${info && info.version} is downloaded. Click Upgrade to restart and install.` });
  });

  autoUpdater.on('error', (err) => {
    const msg = err == null ? 'unknown error' : (err.message || String(err));
    console.error('Auto-update error:', err == null ? 'unknown' : (err.stack || err).toString());
    if (phase === 'downloading' || phase === 'installing' || installRequested) {
      phase = 'idle';
      percent = null;
      installRequested = false;
      report({ state: 'failed', progress: null, error: msg });
    }
  });
}

// -----------------------------------------------------------------------------
// Backend handed to the UpdateChecker (see setBackend contract there)
// -----------------------------------------------------------------------------

function createDesktopBackend() {
  return {
    installMethod: 'desktop',
    supportsInstall: true,
    attach(reportFn) { report = reportFn; },

    // Resolves null when current, or the release descriptor when newer.
    async check() {
      const u = load();
      if (!u) throw new Error('electron-updater is unavailable in this build');
      wireEvents();
      const result = await u.checkForUpdates();
      const info = result && result.updateInfo;
      if (!info || !info.version) return null;
      // electron-updater already compared versions: isUpdateAvailable is false
      // when the feed matches the running build (or is older).
      if (result.isUpdateAvailable === false) return null;
      pendingInfo = info;
      return {
        version: info.version,
        name: info.releaseName || `v${info.version}`,
        url: releaseUrlFor(info.version),
        notes: notesToText(info.releaseNotes),
        published_at: info.releaseDate || null
      };
    },

    // Click handler behind the banner's Upgrade button.
    async install(version, reportFn) {
      if (typeof reportFn === 'function') report = reportFn;
      const u = load();
      if (!u) throw new Error('electron-updater is unavailable in this build');
      wireEvents();
      if (phase === 'ready') {
        restartToInstall();
        return { state: 'installing', progress: 100, detail: 'Restarting to install the update...' };
      }
      if (phase === 'installing') return { state: 'installing', progress: 100 };
      installRequested = true;
      if (phase === 'downloading') {
        return { state: 'downloading', progress: percent, detail: 'Download in progress. The app restarts to install as soon as it finishes.' };
      }
      // Nothing in flight: kick a check (autoDownload starts the download).
      phase = 'downloading';
      percent = 0;
      u.checkForUpdates().catch((e) => {
        phase = 'idle';
        installRequested = false;
        report({ state: 'failed', error: e.message });
      });
      return { state: 'downloading', progress: 0, detail: `Downloading v${String(version).replace(/^v/, '')}...` };
    }
  };
}

// Unsigned macOS: report only, the banner links to the release page.
function createDownloadOnlyBackend() {
  return {
    installMethod: 'download',
    supportsInstall: false,
    attach(reportFn) { report = reportFn; }
    // no check(): the checker falls back to the GitHub Releases API
  };
}

/**
 * Called once from main BEFORE the service starts, so its first scheduled
 * check already runs through the right backend.
 *
 * @param {object} opts
 * @param {object} opts.service        the required src/index.js module
 * @param {function} opts.getMainWindow
 * @param {function} opts.setQuitting
 */
function initAutoUpdater({ service, getMainWindow, setQuitting } = {}) {
  if (typeof getMainWindow === 'function') getWin = getMainWindow;
  if (typeof setQuitting === 'function') markQuitting = setQuitting;
  if (!service || typeof service.setUpdateBackend !== 'function') return;
  getChecker = () => (typeof service.getUpdateChecker === 'function' ? service.getUpdateChecker() : null);

  if (!app.isPackaged) {
    service.setUpdateBackend(null, { mode: 'dev' });
    return;
  }
  if (process.platform === 'darwin') {
    service.setUpdateBackend(createDownloadOnlyBackend(), { mode: 'desktop' });
    return;
  }
  const u = load();
  if (!u) {
    service.setUpdateBackend(createDownloadOnlyBackend(), { mode: 'desktop' });
    return;
  }
  wireEvents();
  service.setUpdateBackend(createDesktopBackend(), { mode: 'desktop' });
}

// Wired to Help > Check for Updates. Gives explicit feedback in every outcome
// and points at the dashboard banner for the actual upgrade.
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
  const checker = getChecker();
  if (!checker) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Updates',
      message: 'The updater is not ready yet. Try again in a moment.'
    });
    return;
  }
  checker.check({ force: true }).then((st) => {
    if (st.last_error && !st.update_available) {
      return dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Update Check Failed',
        message: 'Could not check for updates right now.',
        detail: `${st.last_error}\n\nTry again later, or download the latest release from GitHub.`
      });
    }
    if (!st.update_available) {
      return dialog.showMessageBox(win, {
        type: 'info',
        title: 'No Updates',
        message: 'You are on the latest version.',
        detail: `Version ${app.getVersion()} is current.`
      });
    }
    const canInstall = st.install_method !== 'download';
    return dialog.showMessageBox(win, {
      type: 'info',
      buttons: canInstall ? ['Upgrade Now', 'Later'] : ['Open Download Page', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Available',
      message: `Version ${st.latest_version} is available.`,
      detail: canInstall
        ? `You are running ${st.current_version}. The Upgrade banner on the dashboard installs it; you can also start it here.`
        : `You are running ${st.current_version}. This build cannot update itself; download the new version from GitHub.`
    }).then((r) => {
      if (r.response !== 0) return;
      if (canInstall) {
        if (win) { win.show(); win.focus(); }
        checker.install().catch((e) => {
          dialog.showMessageBox(win, { type: 'warning', title: 'Upgrade', message: 'Could not start the upgrade.', detail: e.message });
        });
      } else {
        shell.openExternal(st.release_url);
      }
    });
  }).catch((e) => {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Update Check Failed',
      message: 'Could not check for updates right now.',
      detail: e.message
    });
  });
}

module.exports = { initAutoUpdater, checkForUpdatesManual };
