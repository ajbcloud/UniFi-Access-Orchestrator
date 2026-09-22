'use strict';

/**
 * Update checker: one source of truth for "is a newer release out, and where
 * are we in installing it". Both the desktop app and the headless service use
 * it, so the dashboard renders the same Upgrade banner everywhere.
 *
 *   - Checks GitHub Releases on a schedule (shortly after boot, then every
 *     `check_interval_hours`) and compares the latest tag to the running
 *     version. The result lands in `state` which /health and /api/update/status
 *     expose to the dashboard.
 *   - An optional backend (electron/updater.js in the packaged desktop app)
 *     can take over the check and the install. Without one, the check goes to
 *     the GitHub API directly and the install uses the headless installer
 *     below.
 *   - The headless installer never writes to the app directory from the
 *     service process: the systemd unit runs it read-only and unprivileged.
 *     Instead it drops a request file in the state directory and a root
 *     oneshot unit (installed by scripts/install-upgrade-helper.sh) runs
 *     scripts/upgrade.sh, which swaps the files, reinstalls dependencies and
 *     restarts the service. When that helper is not installed but the app
 *     directory is writable (a plain `node src/index.js` run under a
 *     supervisor), the script runs directly and the process exits so the
 *     supervisor brings the new version up. Otherwise the banner shows
 *     manual instructions.
 *
 * Everything with a side effect is injectable so the state machine is
 * testable without network, timers, or a filesystem.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');

const DEFAULT_REPO = 'ajbcloud/UniFi-Access-Orchestrator';
const DEFAULT_INTERVAL_HOURS = 6;
const MIN_INTERVAL_HOURS = 1;
const STARTUP_DELAY_MS = 45 * 1000;
const RESULT_POLL_MS = 3000;
const STALE_RUN_MS = 30 * 60 * 1000;
const REQUEST_FILE = 'upgrade.request';
const RESULT_FILE = 'upgrade.result';
const HELPER_PATH_UNIT = '/etc/systemd/system/unifi-access-orchestrator-upgrade.path';

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

function parseVersion(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(s);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

// Standard semver ordering: numeric parts first, then a prerelease sorts
// before its release (1.2.0-beta < 1.2.0). Returns -1, 0 or 1. Unparseable
// input compares as equal so a malformed tag never shows up as "newer".
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  const as = pa.pre.split('.');
  const bs = pb.pre.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] === undefined) return -1;
    if (bs[i] === undefined) return 1;
    const an = /^\d+$/.test(as[i]); const bn = /^\d+$/.test(bs[i]);
    if (an && bn) { if (+as[i] !== +bs[i]) return +as[i] < +bs[i] ? -1 : 1; }
    else if (an) return -1;
    else if (bn) return 1;
    else if (as[i] !== bs[i]) return as[i] < bs[i] ? -1 : 1;
  }
  return 0;
}

function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

function normalizeTag(tag) {
  const p = parseVersion(tag);
  if (!p) return null;
  return `v${p.major}.${p.minor}.${p.patch}${p.pre ? '-' + p.pre : ''}`;
}

// ---------------------------------------------------------------------------
// GitHub release lookup (no dependencies; follows nothing, one JSON GET)
// ---------------------------------------------------------------------------

function fetchLatestRelease({ repo = DEFAULT_REPO, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: `/repos/${repo}/releases/latest`,
      headers: {
        'User-Agent': 'unifi-access-orchestrator-update-check',
        'Accept': 'application/vnd.github+json'
      },
      timeout: timeoutMs
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2 * 1024 * 1024) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const hint = res.statusCode === 403 && /rate limit/i.test(body) ? ' (GitHub API rate limit)' : '';
          return reject(new Error(`GitHub returned HTTP ${res.statusCode}${hint}`));
        }
        try {
          const j = JSON.parse(body);
          resolve({
            tag: j.tag_name,
            version: normalizeTag(j.tag_name),
            name: j.name || j.tag_name,
            url: j.html_url || `https://github.com/${repo}/releases/tag/${j.tag_name}`,
            notes: typeof j.body === 'string' ? j.body.slice(0, 4000) : '',
            published_at: j.published_at || null,
            prerelease: !!j.prerelease
          });
        } catch (e) {
          reject(new Error(`Could not parse GitHub response: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub request timed out')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Headless installer
// ---------------------------------------------------------------------------

function isWritableDir(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/**
 * Decides how this process can upgrade itself and carries the request out.
 *
 *   helper : a root systemd path unit watches STATE_DIR/upgrade.request
 *   direct : the app dir is writable, so run scripts/upgrade.sh in-process
 *   manual : neither; the banner shows the command to run
 */
class HeadlessInstaller {
  constructor({ appDir, stateDir, env = process.env, fsImpl = fs, spawnImpl = spawn, logger = console, exit = (code) => process.exit(code), platform = process.platform } = {}) {
    this.appDir = appDir || path.resolve(__dirname, '..');
    this.fs = fsImpl;
    this.spawn = spawnImpl;
    this.logger = logger;
    this.exit = exit;
    this.platform = platform;
    this.env = env;
    // systemd sets STATE_DIRECTORY when the unit declares StateDirectory=.
    this.stateDir = stateDir || env.UPDATE_STATE_DIR || env.STATE_DIRECTORY || null;
    this.helperInstalled = !!(env.UPDATE_HELPER_INSTALLED === '1' || this._exists(HELPER_PATH_UNIT));
  }

  _exists(p) { try { return this.fs.existsSync(p); } catch (e) { return false; } }

  // Cached briefly: getState() runs on every /health poll and this is a
  // handful of filesystem probes whose answer changes about never.
  mode() {
    const now = Date.now();
    if (this._modeCache && now - this._modeCache.at < 30000) return this._modeCache.mode;
    let mode = 'manual';
    if (this.stateDir && this.helperInstalled && isWritableDir(this.stateDir)) mode = 'helper';
    else if (this.platform !== 'win32' && isWritableDir(this.appDir) && !this._exists(path.join(this.appDir, '.git'))
        && this._exists(path.join(this.appDir, 'scripts', 'upgrade.sh'))) mode = 'direct';
    this._modeCache = { mode, at: now };
    return mode;
  }

  manualInstructions() {
    return [
      'Install the upgrade helper once, then the Upgrade button works from the dashboard:',
      `  sudo bash ${path.join(this.appDir, 'scripts', 'install-upgrade-helper.sh')}`,
      'Or upgrade by hand:',
      `  sudo bash ${path.join(this.appDir, 'scripts', 'upgrade.sh')} latest`
    ].join('\n');
  }

  requestPath() { return this.stateDir ? path.join(this.stateDir, REQUEST_FILE) : null; }
  resultPath() { return this.stateDir ? path.join(this.stateDir, RESULT_FILE) : null; }

  readResult() {
    const p = this.resultPath();
    return p ? readJsonSafe(p) : null;
  }

  clearResult() {
    const p = this.resultPath();
    if (p) { try { this.fs.unlinkSync(p); } catch (e) { /* already gone */ } }
  }

  requestPending() {
    const p = this.requestPath();
    return !!(p && this._exists(p));
  }

  /**
   * Start the upgrade to `version` (a tag like v11.2.4). Resolves with the
   * initial install state; progress arrives through `report(patch)`.
   */
  async install(version, report) {
    const mode = this.mode();
    const tag = normalizeTag(version) || 'latest';
    if (mode === 'helper') {
      const req = { version: tag, requested_at: new Date().toISOString(), pid: process.pid };
      const p = this.requestPath();
      const tmp = `${p}.tmp`;
      this.fs.writeFileSync(tmp, JSON.stringify(req, null, 2));
      this.fs.renameSync(tmp, p);
      this.logger.info(`Update: upgrade to ${tag} requested via helper (${p})`);
      return { state: 'requested', detail: 'Handed to the upgrade helper. The service restarts when it finishes.' };
    }
    if (mode === 'direct') {
      return this._runDirect(tag, report);
    }
    const err = new Error('This install cannot upgrade itself from the dashboard.');
    err.code = 'MANUAL';
    err.instructions = this.manualInstructions();
    throw err;
  }

  _runDirect(tag, report) {
    // Run a private copy of the script: the upgrade replaces scripts/ and bash
    // reads its script incrementally, so the original must not change underneath.
    const src = path.join(this.appDir, 'scripts', 'upgrade.sh');
    const tmpDir = this.fs.mkdtempSync(path.join(os.tmpdir(), 'uao-upgrade-'));
    const copy = path.join(tmpDir, 'upgrade.sh');
    this.fs.copyFileSync(src, copy);
    const stateDir = this.stateDir && isWritableDir(this.stateDir) ? this.stateDir : path.join(this.appDir, '.update-state');
    try { this.fs.mkdirSync(stateDir, { recursive: true }); } catch (e) { /* best effort */ }
    const env = Object.assign({}, this.env, {
      APP_DIR: this.appDir,
      STATE_DIR: stateDir,
      SERVICE: '',            // no systemctl: the process exits and the supervisor restarts it
      APP_USER: '',           // keep current ownership
      UPGRADE_NO_RESTART: '1'
    });
    this.logger.info(`Update: running ${copy} ${tag} directly (app dir is writable)`);
    const child = this.spawn('bash', [copy, tag], { env, cwd: this.appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-2000);
      const line = s.trim().split('\n').pop();
      if (line) report({ state: 'installing', detail: line.slice(0, 200) });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => report({ state: 'failed', error: `Could not start upgrade script: ${e.message}` }));
    child.on('exit', (code) => {
      try { this.fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      if (code === 0) {
        report({ state: 'restarting', detail: `Upgraded to ${tag}. Restarting the service.` });
        this.logger.warn(`Update: upgrade to ${tag} finished. Exiting so the supervisor restarts the new version.`);
        setTimeout(() => this.exit(0), 1500);
      } else {
        const lastLines = tail.trim().split('\n').slice(-3).join(' | ');
        report({ state: 'failed', error: `Upgrade script exited with code ${code}. ${lastLines}`.trim() });
      }
    });
    return { state: 'installing', detail: `Downloading ${tag}...` };
  }
}

// ---------------------------------------------------------------------------
// The checker itself
// ---------------------------------------------------------------------------

class UpdateChecker {
  /**
   * @param {object} opts
   * @param {string} opts.currentVersion   running version (package.json)
   * @param {object} [opts.config]         the `updates` block from config.json
   * @param {function} [opts.fetchLatest]  () => Promise<release>  (GitHub by default)
   * @param {object} [opts.installer]      HeadlessInstaller or compatible
   * @param {object} [opts.logger]
   * @param {function} [opts.now]
   * @param {function} [opts.setTimeout], [opts.clearTimeout], [opts.setInterval], [opts.clearInterval]
   * @param {string} [opts.mode]           'headless' | 'desktop' | 'dev'
   */
  constructor(opts = {}) {
    this.currentVersion = String(opts.currentVersion || '0.0.0').replace(/^v/, '');
    this.repo = opts.repo || DEFAULT_REPO;
    this.logger = opts.logger || console;
    this.now = opts.now || (() => Date.now());
    this._setTimeout = opts.setTimeout || setTimeout;
    this._clearTimeout = opts.clearTimeout || clearTimeout;
    this._setInterval = opts.setInterval || setInterval;
    this._clearInterval = opts.clearInterval || clearInterval;
    this.fetchLatest = opts.fetchLatest || (() => fetchLatestRelease({ repo: this.repo }));
    this.installer = opts.installer || null;
    this.backend = null;
    this.timer = null;
    this.resultTimer = null;
    this.checking = null;
    this.startupDelayMs = opts.startupDelayMs != null ? opts.startupDelayMs : STARTUP_DELAY_MS;
    this.listeners = new Set();

    this.state = {
      enabled: true,
      mode: opts.mode || 'headless',
      install_method: 'manual',
      current_version: this.currentVersion,
      latest_version: null,
      update_available: false,
      release_name: null,
      release_url: `https://github.com/${this.repo}/releases/latest`,
      release_notes: '',
      published_at: null,
      last_check_at: null,
      next_check_at: null,
      last_error: null,
      check_interval_hours: DEFAULT_INTERVAL_HOURS,
      install: { state: 'idle', progress: null, detail: null, error: null, requested_at: null },
      just_upgraded_from: null
    };
    this.configure(opts.config || {});
    this._refreshInstallMethod();
  }

  configure(cfg = {}) {
    const c = cfg || {};
    this.state.enabled = c.enabled !== false;
    let hours = Number(c.check_interval_hours);
    if (!Number.isFinite(hours) || hours <= 0) hours = DEFAULT_INTERVAL_HOURS;
    this.state.check_interval_hours = Math.max(MIN_INTERVAL_HOURS, hours);
    if (this.timer) { this.stop(); this.start(); }
  }

  // The desktop app plugs electron-updater in here. Contract:
  //   check():   Promise<{ version, url?, notes?, published_at?, name? } | null>
  //   install(version, report): Promise<{ state, detail? }>
  //   installMethod: string ('desktop')
  //   supportsInstall: boolean
  setBackend(backend) {
    this.backend = backend || null;
    if (backend && typeof backend.attach === 'function') backend.attach((patch) => this.reportInstall(patch));
    this._refreshInstallMethod();
  }

  _refreshInstallMethod() {
    if (this.backend) this.state.install_method = this.backend.supportsInstall === false ? 'download' : (this.backend.installMethod || 'desktop');
    else if (this.installer) this.state.install_method = this.installer.mode();
    else this.state.install_method = 'manual';
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) { try { fn(this.getState()); } catch (e) { /* listener error */ } } }

  getState() {
    this._refreshInstallMethod();
    return JSON.parse(JSON.stringify(this.state));
  }

  start() {
    if (this.timer || !this.state.enabled) return;
    this._absorbHelperResult();
    const first = this.startupDelayMs;
    this.state.next_check_at = new Date(this.now() + first).toISOString();
    this.timer = this._setTimeout(() => {
      this.timer = null;
      this.check().catch(() => {});
      this._schedule();
    }, first);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    if (this.installer && this.installer.requestPending && this.installer.requestPending()) {
      // A request from before a restart is still in flight; keep watching it.
      this.reportInstall({ state: 'requested', detail: 'Upgrade request pending with the helper.' });
      this._watchHelperResult();
    }
  }

  _schedule() {
    if (!this.state.enabled) return;
    const ms = this.state.check_interval_hours * 3600 * 1000;
    this.state.next_check_at = new Date(this.now() + ms).toISOString();
    this.timer = this._setInterval(() => { this.check().catch(() => {}); this.state.next_check_at = new Date(this.now() + ms).toISOString(); }, ms);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) {
      // A pending first-run timer and the interval are cleared the same way.
      this._clearTimeout(this.timer);
      this._clearInterval(this.timer);
      this.timer = null;
    }
    if (this.resultTimer) { this._clearInterval(this.resultTimer); this.resultTimer = null; }
    this.state.next_check_at = null;
  }

  /**
   * Run one check now. Concurrent calls share the in-flight promise.
   * Resolves with the new state; never rejects for a failed lookup (the
   * error lands in state.last_error) but does surface "updates disabled".
   */
  check({ force = false } = {}) {
    if (!this.state.enabled && !force) return Promise.resolve(this.getState());
    if (this.checking) return this.checking;
    this.checking = this._doCheck().finally(() => { this.checking = null; });
    return this.checking;
  }

  async _doCheck() {
    try {
      let rel = null;
      if (this.backend && typeof this.backend.check === 'function') {
        rel = await this.backend.check();
      } else {
        rel = await this.fetchLatest();
      }
      this.state.last_check_at = new Date(this.now()).toISOString();
      this.state.last_error = null;
      if (rel && rel.version) {
        const latest = String(rel.version).replace(/^v/, '');
        this.state.latest_version = latest;
        this.state.release_name = rel.name || `v${latest}`;
        this.state.release_url = rel.url || `https://github.com/${this.repo}/releases/tag/v${latest}`;
        this.state.release_notes = rel.notes || '';
        this.state.published_at = rel.published_at || null;
        const wasAvailable = this.state.update_available;
        this.state.update_available = isNewer(latest, this.currentVersion);
        if (this.state.update_available && !wasAvailable) {
          this.logger.info(`Update available: v${latest} (running v${this.currentVersion})`);
        }
        // A finished install that still reads "ready"/"downloading" for an
        // older release is stale once a newer one shows up.
        if (!this.state.update_available && ['downloading', 'ready', 'requested'].includes(this.state.install.state)) {
          this._resetInstall();
        }
      } else if (rel === null && this.backend) {
        // The desktop backend answers null for "you are current".
        this.state.update_available = false;
        this.state.latest_version = this.currentVersion;
      }
    } catch (e) {
      this.state.last_check_at = new Date(this.now()).toISOString();
      this.state.last_error = e && e.message ? e.message : String(e);
      this.logger.warn(`Update check failed: ${this.state.last_error}`);
    }
    this._emit();
    return this.getState();
  }

  _resetInstall() {
    this.state.install = { state: 'idle', progress: null, detail: null, error: null, requested_at: null };
  }

  reportInstall(patch) {
    const p = patch || {};
    const cur = this.state.install;
    this.state.install = {
      state: p.state || cur.state,
      progress: p.progress !== undefined ? p.progress : cur.progress,
      detail: p.detail !== undefined ? p.detail : cur.detail,
      error: p.error !== undefined ? p.error : (p.state && p.state !== 'failed' ? null : cur.error),
      requested_at: cur.requested_at
    };
    this._emit();
  }

  /**
   * Upgrade to the latest known release. Resolves with the install state.
   * Rejects with code 'NO_UPDATE' when nothing newer is known, 'BUSY' when an
   * install is already under way, or 'MANUAL' with instructions.
   */
  async install() {
    if (!this.state.update_available || !this.state.latest_version) {
      // One more look before refusing: the user may have clicked right after
      // a release went out and before the next scheduled check.
      await this.check({ force: true });
      if (!this.state.update_available) {
        const err = new Error('No newer release is available.');
        err.code = 'NO_UPDATE';
        throw err;
      }
    }
    const busy = ['requested', 'downloading', 'installing', 'restarting'];
    if (busy.includes(this.state.install.state)) {
      const err = new Error(`An upgrade is already ${this.state.install.state}.`);
      err.code = 'BUSY';
      err.install = this.state.install;
      throw err;
    }
    const version = `v${this.state.latest_version}`;
    this.state.install.requested_at = new Date(this.now()).toISOString();
    const report = (patch) => this.reportInstall(patch);
    try {
      let result;
      if (this.backend && typeof this.backend.install === 'function') {
        if (this.backend.supportsInstall === false) {
          const err = new Error('This build cannot install updates in place. Download the new version from GitHub.');
          err.code = 'MANUAL';
          err.instructions = `Download ${version} from ${this.state.release_url}`;
          throw err;
        }
        result = await this.backend.install(version, report);
      } else if (this.installer) {
        result = await this.installer.install(version, report);
        if (result && result.state === 'requested') this._watchHelperResult();
      } else {
        const err = new Error('No installer is available for this build.');
        err.code = 'MANUAL';
        err.instructions = `Download ${version} from ${this.state.release_url}`;
        throw err;
      }
      this.reportInstall(Object.assign({ progress: null }, result || { state: 'installing' }));
      return this.getState().install;
    } catch (e) {
      if (e && e.code !== 'MANUAL') this.reportInstall({ state: 'failed', error: e.message });
      throw e;
    }
  }

  // Helper mode: the root oneshot writes upgrade.result as it goes. Mirror it
  // into state until the service is restarted underneath us.
  _watchHelperResult() {
    if (!this.installer || !this.installer.readResult || this.resultTimer) return;
    const started = this.now();
    this.resultTimer = this._setInterval(() => {
      const r = this.installer.readResult();
      if (r && r.status === 'running') {
        this.reportInstall({ state: 'installing', detail: r.step || 'Upgrading...' });
      } else if (r && r.status === 'failed') {
        this.reportInstall({ state: 'failed', error: r.error || 'Upgrade failed.' });
        this._clearInterval(this.resultTimer); this.resultTimer = null;
      } else if (r && r.status === 'ok') {
        this.reportInstall({ state: 'restarting', detail: `Upgraded to ${r.version}. Restarting the service.` });
        this._clearInterval(this.resultTimer); this.resultTimer = null;
      } else if (!this.installer.requestPending() && this.now() - started > 2 * 60 * 1000 && !r) {
        // The request vanished with no result: the helper is not really running.
        this.reportInstall({ state: 'failed', error: 'The upgrade helper picked up the request but wrote no result. Check: sudo journalctl -u unifi-access-orchestrator-upgrade' });
        this._clearInterval(this.resultTimer); this.resultTimer = null;
      } else if (this.now() - started > STALE_RUN_MS) {
        this.reportInstall({ state: 'failed', error: 'The upgrade helper did not respond within 30 minutes. Is unifi-access-orchestrator-upgrade.path enabled?' });
        this._clearInterval(this.resultTimer); this.resultTimer = null;
      }
    }, RESULT_POLL_MS);
    if (this.resultTimer && typeof this.resultTimer.unref === 'function') this.resultTimer.unref();
  }

  // On boot: consume the helper's last result so a failure stays visible and
  // a success is acknowledged once.
  _absorbHelperResult() {
    if (!this.installer || !this.installer.readResult) return;
    const r = this.installer.readResult();
    if (!r) return;
    const ver = String(r.version || '').replace(/^v/, '');
    if (r.status === 'ok') {
      if (ver === this.currentVersion || !ver) {
        this.state.just_upgraded_from = r.previous_version || null;
        this.logger.info(`Update: now running v${this.currentVersion}${r.previous_version ? ` (upgraded from ${r.previous_version})` : ''}`);
        this.installer.clearResult();
      } else {
        // The files changed but this process is still the old version: the
        // helper's restart has not happened yet. Say so rather than "idle".
        this.reportInstall({ state: 'restarting', detail: `Upgraded to ${r.version}. Waiting for the service to restart.` });
      }
    } else if (r.status === 'failed') {
      this.reportInstall({ state: 'failed', error: r.error || 'The last upgrade attempt failed.' });
      this.installer.clearResult();
    } else if (r.status === 'running') {
      const started = Date.parse(r.started_at || '') || 0;
      if (this.now() - started > STALE_RUN_MS) {
        this.reportInstall({ state: 'failed', error: 'A previous upgrade never finished. Check: sudo journalctl -u unifi-access-orchestrator-upgrade' });
        this.installer.clearResult();
      } else {
        this.reportInstall({ state: 'installing', detail: r.step || 'Upgrading...' });
        this._watchHelperResult();
      }
    }
  }

  acknowledgeUpgrade() {
    this.state.just_upgraded_from = null;
  }
}

module.exports = {
  UpdateChecker,
  HeadlessInstaller,
  fetchLatestRelease,
  compareVersions,
  parseVersion,
  isNewer,
  normalizeTag,
  DEFAULT_REPO,
  REQUEST_FILE,
  RESULT_FILE
};
