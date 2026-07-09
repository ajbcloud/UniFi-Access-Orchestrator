'use strict';

const { LockDriver, LockState } = require('./lock-driver');

// Z-Wave Door Lock CC (0x62) target modes.
const DOOR_LOCK_MODE = Object.freeze({ UNSECURED: 0x00, SECURED: 0xff });

// Notification CC (0x71) Access Control (type 6) event numbers of interest.
// Source: zwave-js Notifications registry. "Lock jammed" surfaces as a
// lock-state value 0x0b rather than a discrete event, but Schlage firmware has
// been observed to send it as an event arg too, so we treat 0x0b as a jam here.
const AC_NOTIFICATION = Object.freeze({
  MANUAL_LOCK: 0x01,
  MANUAL_UNLOCK: 0x02,
  RF_LOCK: 0x03,
  RF_UNLOCK: 0x04,
  KEYPAD_LOCK: 0x05,
  KEYPAD_UNLOCK: 0x06,
  LOCK_JAMMED: 0x0b,
});

const LOCK_EVENTS = new Set([
  AC_NOTIFICATION.MANUAL_LOCK,
  AC_NOTIFICATION.RF_LOCK,
  AC_NOTIFICATION.KEYPAD_LOCK,
]);
const UNLOCK_EVENTS = new Set([
  AC_NOTIFICATION.MANUAL_UNLOCK,
  AC_NOTIFICATION.RF_UNLOCK,
  AC_NOTIFICATION.KEYPAD_UNLOCK,
]);

function modeToState(mode) {
  if (mode === DOOR_LOCK_MODE.SECURED) return LockState.LOCKED;
  if (mode === DOOR_LOCK_MODE.UNSECURED) return LockState.UNLOCKED;
  return LockState.UNKNOWN;
}

/**
 * Drives a Z-Wave deadbolt (Schlage BE469ZP) via zwave-js.
 *
 * zwave-js is injected through `deps`, so this module is fully unit-testable
 * without the native package or hardware:
 *   - deps.node          : a ready ZWaveNode-like object (used in tests)
 *   - deps.driverFactory : (cfg) => Driver-like (production seam)
 * In production neither is passed and init() lazy-requires zwave-js. The
 * package is intentionally NOT a hard dependency in package.json so a client
 * without the deadbolt can npm install without a native build; install
 * zwave-js on the middleware host when the hardware is deployed.
 *
 * Verification model: the BE469ZP is documented as slow and eventually
 * consistent, so timeouts are generous. After a set we wait for a confirming
 * Notification / Door Lock report, fall back to one getState() read on timeout,
 * and retry up to verify_retries. A failed LOCK is low severity (the Schlage
 * auto-lock backstops it); a failed UNLOCK is surfaced for alerting.
 */
class ZwaveLock extends LockDriver {
  constructor(cfg = {}, deps = {}) {
    super();
    this.cfg = cfg;
    this.logger = deps.logger || console;
    this._driverFactory = deps.driverFactory || null;
    this._injectedNode = deps.node || null;

    this._driver = null;
    this._node = null;
    this._state = { boltState: LockState.UNKNOWN, battery: null, online: false, lastSeen: null };

    this.nodeId = cfg.node_id;
    this.verifyTimeoutMs = cfg.verify_timeout_ms == null ? 12000 : cfg.verify_timeout_ms;
    this.verifyRetries = cfg.verify_retries == null ? 1 : cfg.verify_retries;
  }

  get capabilities() {
    return new Set(['lock', 'unlock', 'state', 'battery']);
  }

  async init() {
    if (this._injectedNode) {
      this._node = this._injectedNode;
    } else {
      this._driver = await this._createDriver();
      this._node = this._resolveNode(this._driver);
    }
    if (!this._node) throw new Error(`Z-Wave node ${this.nodeId} not found`);
    this._wireNode(this._node);
    this._state.online = true;
    try {
      await this._seedState();
    } catch (err) {
      this.logger.warn && this.logger.warn(`ZwaveLock: initial state read failed: ${err.message}`);
    }
    this.emit('online');
  }

  async _createDriver() {
    if (this._driverFactory) return this._driverFactory(this.cfg);
    let ZWaveJS;
    try {
      // Lazy require: tests and non-deadbolt installs never load the native package.
      ZWaveJS = require('zwave-js'); // eslint-disable-line global-require
    } catch (err) {
      throw new Error(
        'zwave-js is not installed. Install it on the middleware host to drive the deadbolt ' +
        '(npm install zwave-js@<confirmed version>), or run with the fake lock driver in dev.'
      );
    }
    const keys = this._loadSecurityKeys();
    const driver = new ZWaveJS.Driver(this.cfg.serial_path, {
      securityKeys: keys.classic,
      securityKeysLongRange: keys.longRange,
      storage: this.cfg.cache_dir ? { cacheDir: this.cfg.cache_dir } : undefined,
    });
    await new Promise((resolve, reject) => {
      driver.once('driver ready', resolve);
      driver.once('error', reject);
      Promise.resolve()
        .then(() => driver.start())
        .catch(reject);
    });
    return driver;
  }

  _resolveNode(driver) {
    const nodes = driver && driver.controller && driver.controller.nodes;
    if (!nodes) return null;
    return typeof nodes.get === 'function' ? nodes.get(this.nodeId) : nodes[this.nodeId];
  }

  _loadSecurityKeys() {
    const hex = (name) => {
      const v = process.env[name];
      return v ? Buffer.from(v, 'hex') : undefined;
    };
    return {
      classic: {
        S2_AccessControl: hex('ZWAVE_S2_ACCESS_CONTROL'),
        S2_Authenticated: hex('ZWAVE_S2_AUTHENTICATED'),
        S2_Unauthenticated: hex('ZWAVE_S2_UNAUTHENTICATED'),
        S0_Legacy: hex('ZWAVE_S0_LEGACY'),
      },
      longRange: {
        S2_AccessControl: hex('ZWAVE_LR_S2_ACCESS_CONTROL'),
        S2_Authenticated: hex('ZWAVE_LR_S2_AUTHENTICATED'),
      },
    };
  }

  _wireNode(node) {
    if (!node || typeof node.on !== 'function') return;
    node.on('notification', (_endpoint, ccId, args) => this._onNotification(ccId, args || {}));
    node.on('value updated', (_node, args) => this._onValueUpdated(args || {}));
    node.on('dead', () => this._setOnline(false));
    node.on('alive', () => this._setOnline(true));
  }

  _onNotification(_ccId, args) {
    const event = args.event;
    if (event === AC_NOTIFICATION.LOCK_JAMMED) {
      this._updateState(LockState.JAMMED);
      return;
    }
    if (LOCK_EVENTS.has(event)) this._updateState(LockState.LOCKED);
    else if (UNLOCK_EVENTS.has(event)) this._updateState(LockState.UNLOCKED);
  }

  _onValueUpdated(args) {
    const isDoorLock = args.commandClassName === 'Door Lock' || args.commandClass === 0x62;
    if (isDoorLock && args.property === 'currentMode') {
      this._updateState(modeToState(args.newValue));
    }
    const isBattery = args.commandClassName === 'Battery' || args.commandClass === 0x80;
    if (isBattery && args.property === 'level' && typeof args.newValue === 'number') {
      this._state.battery = args.newValue;
      this.emit('state-change', this.snapshot());
    }
  }

  _updateState(boltState) {
    this._state.boltState = boltState;
    this._state.lastSeen = new Date().toISOString();
    this.emit('state-change', this.snapshot());
  }

  _setOnline(online) {
    if (this._state.online !== online) {
      this._state.online = online;
      this.emit(online ? 'online' : 'offline');
    }
  }

  _doorLockCC() {
    const cc = this._node && this._node.commandClasses;
    if (!cc) return null;
    return cc['Door Lock'] || cc.doorLock || null;
  }

  async _seedState() {
    const dl = this._doorLockCC();
    if (dl && typeof dl.get === 'function') {
      const rep = await dl.get();
      if (rep && rep.currentMode != null) this._updateState(modeToState(rep.currentMode));
    }
  }

  async _commandSet(mode) {
    const dl = this._doorLockCC();
    if (!dl || typeof dl.set !== 'function') throw new Error('Door Lock CC unavailable');
    await dl.set(mode);
  }

  _waitForState(wantState, timeoutMs) {
    return new Promise((resolve) => {
      if (this._state.boltState === wantState) return resolve(true);
      let done = false;
      const settle = (val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.removeListener('state-change', onChange);
        resolve(val);
      };
      const onChange = (snap) => {
        if (snap.boltState === wantState) settle(true);
        // A jam is a terminal failure for this command and must not be papered
        // over by the fallback read below; report it and stop waiting.
        else if (snap.boltState === LockState.JAMMED && wantState !== LockState.JAMMED) settle(false);
      };
      const finish = async () => {
        if (done) return;
        // Last-ditch read in case a confirming report was missed on the wire.
        try { await this._seedState(); } catch (e) { /* best effort */ }
        settle(this._state.boltState === wantState);
      };
      const timer = setTimeout(finish, timeoutMs);
      this.on('state-change', onChange);
    });
  }

  async _setVerified(mode, wantState, action, reason) {
    let last = this._state.boltState;
    for (let attempt = 0; attempt <= this.verifyRetries; attempt++) {
      try {
        await this._commandSet(mode);
      } catch (err) {
        this.logger.warn && this.logger.warn(
          `ZwaveLock ${action} attempt ${attempt + 1} set error: ${err.message}`);
        continue;
      }
      const ok = await this._waitForState(wantState, this.verifyTimeoutMs);
      last = this._state.boltState;
      if (ok) return { success: true, boltState: last };
      this.logger.warn && this.logger.warn(
        `ZwaveLock ${action} not confirmed (attempt ${attempt + 1}/${this.verifyRetries + 1}), state=${last}`);
    }
    return { success: false, boltState: last, error: 'not verified' };
  }

  async lock(reason) {
    return this._setVerified(DOOR_LOCK_MODE.SECURED, LockState.LOCKED, 'lock', reason);
  }

  async unlock(reason) {
    return this._setVerified(DOOR_LOCK_MODE.UNSECURED, LockState.UNLOCKED, 'unlock', reason);
  }

  async getState() {
    return this.snapshot();
  }

  snapshot() {
    return Object.assign({}, this._state);
  }

  async shutdown() {
    this._setOnline(false);
    if (this._driver && typeof this._driver.destroy === 'function') {
      try { await this._driver.destroy(); } catch (e) { /* ignore teardown errors */ }
    }
    this._driver = null;
  }
}

module.exports = { ZwaveLock, DOOR_LOCK_MODE, AC_NOTIFICATION, modeToState };
