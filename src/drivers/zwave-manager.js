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
 * Events: 'driver-error' (err), 'stopped'.
 */
class ZwaveManager extends EventEmitter {
  constructor(deps = {}) {
    super();
    this.logger = deps.logger || console;
    this._driverFactory = deps.driverFactory || null;
    this._loadKeys = deps.loadKeys || (() => ({ classic: {}, longRange: {} }));
    // When a log directory is provided, the zwave-js driver writes a rotating
    // debug log there (zwave-js_*.log). This captures the full S2 inclusion
    // handshake, which is the only way to diagnose a "secure join" failure.
    this.logDir = deps.logDir || null;
    const VALID_LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
    this.logLevel = VALID_LEVELS.includes(deps.logLevel) ? deps.logLevel : 'debug';
    this.cryptoPatched = null; // ciphers the crypto shim replaced (null = not checked yet)
    this._driver = null;
    this._serialPath = null;
    this._starting = null; // in-flight ensureStarted promise, shared by callers
    this._onDriverError = (err) => {
      this.logger.warn && this.logger.warn(`Z-Wave driver error: ${err && err.message}`);
      this.emit('driver-error', err);
    };
  }

  get driver() { return this._driver; }

  get controller() { return this._driver ? this._driver.controller : null; }

  get serialPath() { return this._serialPath; }

  isRunning() { return !!this._driver; }

  getNode(nodeId) {
    const nodes = this._driver && this._driver.controller && this._driver.controller.nodes;
    if (!nodes) return null;
    return typeof nodes.get === 'function' ? nodes.get(nodeId) : nodes[nodeId];
  }

  /**
   * Start (or reuse) the driver for serial_path. Idempotent: a running driver
   * on the same path resolves immediately; concurrent callers share one
   * in-flight start. A different path while running is an error (stop first).
   * On a failed start the driver is destroyed so the port is never left held.
   */
  async ensureStarted({ serial_path, cache_dir } = {}) {
    if (!serial_path) throw new Error('No Z-Wave serial path configured');
    if (this._driver) {
      if (this._serialPath !== serial_path) {
        throw new Error(`Z-Wave controller already running on ${this._serialPath}; stop it before switching ports`);
      }
      return this._driver;
    }
    if (this._starting) return this._starting;

    this._starting = this._start(serial_path, cache_dir);
    try {
      return await this._starting;
    } finally {
      this._starting = null;
    }
  }

  async _start(serialPath, cacheDir) {
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

    const driver = factory(serialPath, {
      securityKeys: keys.classic,
      securityKeysLongRange: keys.longRange,
      storage: cacheDir ? { cacheDir } : undefined,
      logConfig,
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
    return driver;
  }

  async stop() {
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
