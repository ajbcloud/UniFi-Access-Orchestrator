'use strict';

const { LockDriver, LockState } = require('./lock-driver');
const { ZwaveManager } = require('./zwave-manager');
const { loadSecurityKeys } = require('./zwave-keys');

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
 *   - deps.manager       : a shared ZwaveManager owning the Driver (production;
 *                          lets pairing and the lock share one serial port)
 *   - deps.driverFactory : (serialPath, options) => Driver-like (test seam,
 *                          wrapped in a private ZwaveManager)
 * With none of these, a private manager is created and zwave-js is
 * lazy-required on init(). The package is an optionalDependency so installs
 * without the native build still run (the add-on just stays disabled).
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
    this._injectedNode = deps.node || null;

    // A shared manager (production) is owned by the caller; a private one
    // (standalone/headless or the driverFactory test seam) is owned here and
    // torn down on shutdown or on a failed init, so the port never leaks.
    if (deps.manager) {
      this._manager = deps.manager;
      this._ownsManager = false;
    } else {
      this._manager = new ZwaveManager({
        logger: this.logger,
        driverFactory: deps.driverFactory || null,
        loadKeys: () => {
          const k = loadSecurityKeys({ security_keys: cfg.security_keys });
          return { classic: k.classic, longRange: k.longRange };
        },
      });
      this._ownsManager = true;
    }

    this._driver = null;
    this._node = null;
    this._onManagerError = null;
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
      try {
        this._driver = await this._manager.ensureStarted({
          serial_path: this.cfg.serial_path,
          cache_dir: this.cfg.cache_dir,
        });
        this._node = this._resolveNode(this._driver);
        if (!this._node) throw new Error(`Z-Wave node ${this.nodeId} not found`);
      } catch (err) {
        // Port-leak fix: a private manager must not keep the serial port open
        // after a failed init. A SHARED manager stays up (pairing may need the
        // live controller precisely because the node does not exist yet).
        if (this._ownsManager) {
          try { await this._manager.stop(); } catch (e) { /* best effort */ }
        }
        this._driver = null;
        throw err;
      }
    }
    if (!this._node) throw new Error(`Z-Wave node ${this.nodeId} not found`);
    this._wireNode(this._node);
    // Driver-level errors flow through the manager (which holds the persistent
    // listener so the process never crashes on an unhandled 'error'); mirror
    // them into this lock's online state. Handler stored so shutdown() can
    // remove it and a rebuilt lock does not stack subscriptions.
    if (!this._onManagerError) {
      this._onManagerError = () => this._setOnline(false);
      this._manager.on('driver-error', this._onManagerError);
    }
    this._state.online = true;
    try {
      await this._seedState();
    } catch (err) {
      this.logger.warn && this.logger.warn(`ZwaveLock: initial state read failed: ${err.message}`);
    }
    this.emit('online');
  }

  _resolveNode(driver) {
    const nodes = driver && driver.controller && driver.controller.nodes;
    if (!nodes) return null;
    return typeof nodes.get === 'function' ? nodes.get(this.nodeId) : nodes[this.nodeId];
  }

  _wireNode(node) {
    if (!node || typeof node.on !== 'function') return;
    if (this._wired) return; // idempotent: never stack duplicate listeners on re-init
    this._wired = true;
    // Handlers are stored so _unwireNode can remove them: a rebuilt lock
    // (e.g. right after pairing) rebinds the SAME live node, and stacked
    // listeners would double-fire every notification.
    this._nodeHandlers = {
      notification: (_endpoint, ccId, args) => this._onNotification(ccId, args || {}),
      'value updated': (_node, args) => this._onValueUpdated(args || {}),
      dead: () => this._setOnline(false),
      alive: () => this._setOnline(true),
    };
    for (const [ev, fn] of Object.entries(this._nodeHandlers)) node.on(ev, fn);
  }

  _unwireNode() {
    const node = this._node;
    if (node && this._nodeHandlers && typeof node.removeListener === 'function') {
      for (const [ev, fn] of Object.entries(this._nodeHandlers)) node.removeListener(ev, fn);
    }
    this._nodeHandlers = null;
    this._wired = false;
  }

  _onNotification(ccId, args) {
    // Only Access Control (type 6) notifications on Notification CC (0x71)
    // describe lock/unlock/jam. Other notification types reuse the same event
    // numbers for unrelated meanings, so gate strictly before mapping, or an
    // unrelated notification could corrupt bolt state and falsely confirm a set.
    if (ccId != null && ccId !== 0x71) return;
    if (args.type != null && args.type !== 6) return;
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
    this._unwireNode();
    if (this._onManagerError) {
      this._manager.removeListener('driver-error', this._onManagerError);
      this._onManagerError = null;
    }
    // A shared manager belongs to the caller (pairing may still need the
    // driver); only a privately-owned one is destroyed here.
    if (this._ownsManager && this._manager.isRunning()) {
      await this._manager.stop();
    }
    this._driver = null;
    this._node = null;
  }
}

module.exports = { ZwaveLock, DOOR_LOCK_MODE, AC_NOTIFICATION, modeToState };
