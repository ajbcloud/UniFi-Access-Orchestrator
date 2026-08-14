'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

/**
 * Sole owner of the zwave-js Driver for the configured serial path. Both the
 * lock driver (node-level work) and the pairing flow (controller-level
 * inclusion/exclusion) borrow the driver from here, so the serial port is
 * never opened twice and a failed start can never leak the port.
 *
 * deps:
 *   logger        - winston-like (warn/info), defaults to console
 *   driverFactory - (serialPath, options) => Driver-like. Default lazy-requires
 *                   zwave-js so tests and non-deadbolt installs never load the
 *                   native package.
 *   loadKeys      - () => { classic, longRange } security keys (Buffers).
 *
 * Events: 'driver-error' (err), 'driver-down' (err), 'driver-restarted',
 * 'serial-resolved' ({requested, resolved, matched_by, changed}), 'stopped'.
 *
 * Self-healing: this box runs unattended in a network rack. A driver 'error'
 * used to only be logged, leaving a dead driver that still claimed to be
 * running until someone restarted the app. Now a driver error tears the
 * driver down and enters a capped-backoff restart loop that keeps retrying
 * forever (5s doubling to 60s).
 *
 * Serial resolution: the loop above only heals an unplug/replug when the OS
 * hands the stick back the SAME name. On Windows a re-plug or reboot often
 * renumbers COM3 to COM5, which used to be a permanent outage (every retry
 * reopened the dead COM3). The optional deps.resolveSerial re-finds the stick
 * by its USB identity before each start, so the loop reopens wherever the stick
 * actually is. It fires 'serial-resolved' after every successful start (with
 * changed=true when the port moved) so the app can persist the new path.
 * Absent the dep, behavior is exactly as before. An explicit stop() cancels the
 * loop (an operator decision beats healing).
 */
class ZwaveManager extends EventEmitter {
  constructor(deps = {}) {
    super();
    this.logger = deps.logger || console;
    this._driverFactory = deps.driverFactory || null;
    this._loadKeys = deps.loadKeys || (() => ({ classic: {}, longRange: {} }));
    // Optional: async ({serial_path}) => {path, matched_by, changed, ambiguous}.
    // Re-finds the stick by USB identity so a renumbered port still opens. When
    // absent, the requested path is used verbatim (original behavior).
    this._resolveSerial = deps.resolveSerial || null;
    // Edge-trigger for the "cannot pick between several sticks" warning so the
    // restart loop does not log it on every retry during an outage.
    this._lastResolveWarn = null;
    // When a log directory is provided, the zwave-js driver writes a rotating
    // debug log there (zwave-js_*.log). This captures the full S2 inclusion
    // handshake, which is the only way to diagnose a "secure join" failure.
    this.logDir = deps.logDir || null;
    // Persistent fallback for the zwave-js cache when the operator sets no
    // cache_dir. Without it zwave-js defaults to <cwd>/cache, which sits in
    // the install dir on a packaged app and is wiped by every update; a lost
    // cache makes the next node interview "initial", and an initial interview
    // CLEARS every keypad code on a lock (UserCodeCC: node not bootstrapped
    // plus queryAllUserCodes false selects the delete action).
    this.defaultCacheDir = deps.defaultCacheDir || null;
    // Where zwave-js used to end up caching (test seam; prod is <cwd>/cache).
    this.legacyCacheDir = deps.legacyCacheDir || path.join(process.cwd(), 'cache');
    this._effectiveCacheDir = null; // resolved at start, for diagnostics
    const VALID_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
    this.logLevel = VALID_LEVELS.includes(deps.logLevel) ? deps.logLevel : 'debug';
    this.cryptoPatched = null; // ciphers the crypto shim replaced (null = not checked yet)
    this._driver = null;
    this._serialPath = null;
    this._starting = null; // in-flight ensureStarted promise, shared by callers
    // Restart-loop state. Base/cap are configurable so tests run in ms.
    this._restartBaseMs = deps.restartBaseMs == null ? 5000 : deps.restartBaseMs;
    this._restartMaxMs = deps.restartMaxMs == null ? 60000 : deps.restartMaxMs;
    this._restartInfo = null; // { serial_path, cache_dir } from the last good start
    this._restartTimer = null;
    this._restartAttempt = 0;
    this._restartCount = 0; // lifetime successful auto-restarts, for diagnostics
    this._lastDriverError = null;
    this._onDriverError = (err) => {
      this.logger.warn && this.logger.warn(`Z-Wave driver error: ${err && err.message}`);
      this.emit('driver-error', err);
      this._handleDriverDown(err);
    };
  }

  get driver() { return this._driver; }

  get controller() { return this._driver ? this._driver.controller : null; }

  get serialPath() { return this._serialPath; }

  isRunning() { return !!this._driver; }

  /** Diagnostics snapshot: running state plus the self-heal loop's history. */
  status() {
    return {
      running: !!this._driver,
      serial_path: this._serialPath,
      cache_dir: this._effectiveCacheDir,
      restart_pending: !!this._restartTimer,
      restart_attempt: this._restartAttempt,
      auto_restarts: this._restartCount,
      last_driver_error: this._lastDriverError,
    };
  }

  /**
   * A live driver errored (stick unplugged, serial stall, SDK fault). Tear it
   * down so isRunning() tells the truth, tell subscribers, and start the
   * restart loop. Idempotent: a second error while already down is ignored.
   */
  _handleDriverDown(err) {
    const driver = this._driver;
    if (!driver) return;
    this._driver = null;
    this._serialPath = null;
    this._lastDriverError = (err && err.message) || String(err);
    if (typeof driver.removeListener === 'function') driver.removeListener('error', this._onDriverError);
    // Destroy asynchronously and best-effort: the port may already be gone.
    Promise.resolve()
      .then(() => (typeof driver.destroy === 'function' ? driver.destroy() : null))
      .catch(() => { /* already dead */ });
    this.emit('driver-down', err);
    this._scheduleRestart();
  }

  _scheduleRestart() {
    if (this._restartTimer || !this._restartInfo) return;
    const delay = Math.min(this._restartBaseMs * 2 ** this._restartAttempt, this._restartMaxMs);
    this._restartAttempt++;
    this.logger.warn && this.logger.warn(
      `Z-Wave: driver down; auto-restart attempt ${this._restartAttempt} in ${Math.round(delay / 1000)}s`);
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.ensureStarted(this._restartInfo)
        .then(() => {
          this._restartCount++;
          this.logger.info && this.logger.info('Z-Wave: driver auto-restarted after failure');
          this.emit('driver-restarted');
        })
        .catch((e) => {
          this.logger.warn && this.logger.warn(`Z-Wave: driver auto-restart failed: ${e.message}`);
          this._scheduleRestart();
        });
    }, delay);
    if (typeof this._restartTimer.unref === 'function') this._restartTimer.unref();
  }

  getNode(nodeId) {
    const nodes = this._driver && this._driver.controller && this._driver.controller.nodes;
    if (!nodes) return null;
    return typeof nodes.get === 'function' ? nodes.get(nodeId) : nodes[nodeId];
  }

  /**
   * Start (or reuse) the driver for serial_path. Idempotent: a running driver
   * on the same path resolves immediately; concurrent callers share one
   * in-flight start. On a failed start the driver is destroyed so the port is
   * never left held.
   *
   * serial_path is the CONFIGURED path; when a resolveSerial dep is present it
   * is re-mapped to wherever the stick actually is before the driver opens it.
   * That is why a "different path while running" is not automatically an error:
   * a lock built from a stale config snapshot (index.js freezes serial_path per
   * lock) can ask for the old COM port after an auto-heal moved us; if that
   * request resolves back to the running port, hand back the live driver
   * instead of throwing. Only a genuinely different stick is an error.
   */
  async ensureStarted({ serial_path, cache_dir } = {}) {
    if (!serial_path) throw new Error('No Z-Wave serial path configured');
    if (this._driver) {
      if (this._serialPath === serial_path) return this._driver;
      // The request names a different path than the one we are open on. Resolve
      // it: a stale-snapshot retry re-mapping to the running port is not a
      // conflict. Resolving here (not blindly throwing) is what stops the
      // init-retry loop from failing forever after a heal.
      const resolved = await this._resolveRequested(serial_path);
      if (resolved.path === this._serialPath) return this._driver;
      throw new Error(`Z-Wave controller already running on ${this._serialPath}; stop it before switching ports`);
    }
    if (this._starting) return this._starting;

    // Assign _starting SYNCHRONOUSLY (before the first await inside
    // _resolveThenStart) so concurrent callers still share one in-flight start.
    this._starting = this._resolveThenStart(serial_path, cache_dir);
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  /**
   * Map a requested serial path to where the stick actually is, using the
   * injected resolver. ALWAYS returns {path, matched_by, changed}. Degrades to
   * the requested path verbatim when there is no resolver, the resolver throws,
   * or nothing matched, so error messages and the no-dep behavior are unchanged.
   * Edge-triggers the "too many candidates" warning so an outage does not log it
   * on every retry.
   */
  async _resolveRequested(requestedPath) {
    const asIs = { path: requestedPath, matched_by: null, changed: false };
    if (!this._resolveSerial) return asIs;
    let r;
    try {
      r = await this._resolveSerial({ serial_path: requestedPath });
    } catch (e) {
      this.logger.warn && this.logger.warn(`Z-Wave: serial resolve failed; using ${requestedPath} as-is: ${e.message}`);
      return asIs;
    }
    if (r && r.ambiguous && !r.path) {
      const msg = `Z-Wave: cannot auto-pick the stick (${r.candidate_count || 'several'} candidate ports); leaving the saved port in place`;
      if (this._lastResolveWarn !== msg) {
        this.logger.warn && this.logger.warn(msg);
        this._lastResolveWarn = msg;
      }
    } else {
      this._lastResolveWarn = null;
    }
    return (r && r.path) ? { path: r.path, matched_by: r.matched_by || null, changed: !!r.changed } : asIs;
  }

  // Resolve the requested path, then start on wherever the stick resolved to.
  // Kept separate from ensureStarted so the _starting assignment is synchronous.
  async _resolveThenStart(requestedPath, cacheDir) {
    const resolved = await this._resolveRequested(requestedPath);
    return this._start(resolved.path, cacheDir, {
      requested: requestedPath,
      matched_by: resolved.matched_by,
      changed: resolved.changed,
    });
  }

  async _start(serialPath, cacheDir, resolution = null) {
    const factory = this._driverFactory || ((p, opts) => {
      // Electron's crypto lacks ciphers S2 needs (notably aes-128-ccm), which
      // made every secure join fail with "Unknown cipher". The shim swaps in
      // zwave-js's own portable implementations for exactly the missing
      // ciphers, and MUST run before the first require('zwave-js').
      try {
        const shim = require('./zwave-crypto-shim'); // eslint-disable-line global-require
        const res = shim.install();
        this.cryptoPatched = res.patched || [];
        if (res.patched && res.patched.length) {
          this.logger.warn && this.logger.warn(
            `Z-Wave crypto: this runtime lacks ${res.patched.join(', ')}; using zwave-js portable implementations`);
        } else if (res.error) {
          this.logger.warn && this.logger.warn(`Z-Wave crypto shim unavailable: ${res.error}`);
        }
      } catch (e) {
        this.logger.warn && this.logger.warn(`Z-Wave crypto shim failed: ${e.message}`);
      }
      let ZWaveJS;
      try {
        // Lazy require: tests and non-deadbolt installs never load the native package.
        ZWaveJS = require('zwave-js'); // eslint-disable-line global-require
      } catch (err) {
        throw new Error(
          'zwave-js is not installed in this build, so the Z-Wave deadbolt cannot be used. ' +
          'Reinstall the app (the Windows build bundles it), or npm install zwave-js on a headless host.'
        );
      }
      return new ZWaveJS.Driver(p, opts);
    });

    const keys = this._loadKeys();

    // Build a file-logging config only when a log directory is configured, so
    // tests and headless runs stay quiet. The driver appends a date and
    // rotates, keeping maxFiles days of history.
    let logConfig;
    if (this.logDir) {
      try { fs.mkdirSync(this.logDir, { recursive: true }); } catch (e) { /* best effort */ }
      logConfig = {
        enabled: true,
        level: this.logLevel,
        logToFile: true,
        filename: path.join(this.logDir, 'zwave.log'),
        maxFiles: 7,
        forceConsole: false,
      };
    }

    // Resolve where zwave-js keeps its network cache. An operator-set dir
    // always wins verbatim; otherwise fall back to the injected persistent
    // default (and give any cache stranded in the old <cwd>/cache location a
    // one-time lift so the move never forces a fresh full interview).
    const effectiveCacheDir = cacheDir || this.defaultCacheDir || null;
    if (effectiveCacheDir) {
      try { fs.mkdirSync(effectiveCacheDir, { recursive: true }); } catch (e) { /* zwave-js reports if unusable */ }
      if (!cacheDir) this._migrateLegacyCache(effectiveCacheDir);
    }
    this._effectiveCacheDir = effectiveCacheDir;

    const driver = factory(serialPath, {
      securityKeys: keys.classic,
      securityKeysLongRange: keys.longRange,
      storage: effectiveCacheDir ? { cacheDir: effectiveCacheDir } : undefined,
      logConfig,
      interview: {
        // Yale battery-drain guard (zwave-js issue 2725): older Yale locks
        // loop NodeInfo and flatten their batteries when all user codes are
        // queried during the interview. The PIN manager does TARGETED
        // per-slot User Code reads/writes instead, so the interview-wide
        // query stays off. false matches the zwave-js default; stating it
        // here makes the guard explicit and survives upstream default
        // changes.
        queryAllUserCodes: false,
      },
    });

    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          driver.removeListener('driver ready', onReady);
          driver.removeListener('error', onErr);
        };
        const onReady = () => { cleanup(); resolve(); };
        const onErr = (e) => { cleanup(); reject(e); };
        driver.once('driver ready', onReady);
        driver.once('error', onErr);
        Promise.resolve()
          .then(() => driver.start())
          .catch(onErr);
      });
    } catch (err) {
      // Never leave a half-started driver holding the serial port.
      try { if (typeof driver.destroy === 'function') await driver.destroy(); } catch (e) { /* best effort */ }
      throw err;
    }

    // Persistent error handler: without a listener a later 'error' would be an
    // unhandled EventEmitter error and crash the process.
    if (typeof driver.on === 'function') driver.on('error', this._onDriverError);
    this._driver = driver;
    this._serialPath = serialPath;
    // Remember how to start so the restart loop can heal without help, and
    // reset the loop: a successful start (from any caller) ends the outage.
    this._restartInfo = { serial_path: serialPath, cache_dir: cacheDir };
    this._restartAttempt = 0;
    this._lastResolveWarn = null; // outage over: re-arm the ambiguity warning
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    // Announce the port the driver actually opened, ONLY now that 'driver ready'
    // has proved it really is the stick. Firing before this would let a wrong
    // guess (e.g. another CP210x device) get persisted as the saved port and
    // poison the config. The listener in index.js captures identity and, when
    // changed, heals config.serial_path to here. changed=false still fires so
    // the very first good start can capture identity for a legacy install.
    this.emit('serial-resolved', {
      requested: resolution ? resolution.requested : serialPath,
      resolved: serialPath,
      matched_by: resolution ? resolution.matched_by : null,
      changed: !!(resolution && resolution.changed),
    });
    return driver;
  }

  /**
   * One-time, best-effort copy of a zwave-js cache stranded in the legacy
   * default location (<cwd>/cache) into the persistent dir. Losing the cache
   * is destructive far beyond slow startups: the next interview is treated as
   * initial and wipes every keypad code on the lock, so keeping the paired
   * network's cache across app updates genuinely matters. Never overwrites a
   * populated target and never fails the driver start.
   */
  _migrateLegacyCache(targetDir) {
    try {
      const legacy = this.legacyCacheDir;
      if (!legacy || path.resolve(legacy) === path.resolve(targetDir)) return 0;
      const jsonlIn = (dir) => {
        try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch (e) { return []; }
      };
      if (jsonlIn(targetDir).length) return 0; // already populated: never overwrite
      const files = jsonlIn(legacy);
      if (!files.length) return 0;
      for (const f of files) fs.copyFileSync(path.join(legacy, f), path.join(targetDir, f));
      this.logger.info && this.logger.info(
        `Z-Wave: migrated ${files.length} cache file(s) from ${legacy} to ${targetDir} `
        + '(persistent location; keeps the paired network state across app updates)');
      return files.length;
    } catch (e) {
      this.logger.warn && this.logger.warn(`Z-Wave: legacy cache migration skipped: ${e.message}`);
      return 0;
    }
  }

  async stop() {
    // An explicit stop is an operator decision: cancel any pending self-heal
    // so we do not resurrect a driver someone deliberately shut down.
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    this._restartInfo = null;
    this._restartAttempt = 0;
    const driver = this._driver;
    this._driver = null;
    this._serialPath = null;
    if (driver) {
      if (typeof driver.removeListener === 'function') driver.removeListener('error', this._onDriverError);
      try {
        if (typeof driver.destroy === 'function') await driver.destroy();
      } catch (e) { /* ignore teardown errors */ }
    }
    this.emit('stopped');
  }
}

module.exports = { ZwaveManager };
