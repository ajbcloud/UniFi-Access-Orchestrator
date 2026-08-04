'use strict';

const { LockDriver, LockState } = require('./lock-driver');

/**
 * In-memory lock for unit tests and for running the add-on in dev / dry-run
 * without a Z-Wave stick attached. Records every actuation in `calls` so tests
 * can assert on them, and can be told to fail, jam, or go offline to exercise
 * the error paths in the rules engine and the orchestrator wiring.
 *
 * behavior toggles: { offline, failNext, jamOnLock }
 */
class FakeLock extends LockDriver {
  constructor(opts = {}) {
    super();
    this._state = opts.initial || LockState.LOCKED;
    this._battery = opts.battery == null ? 100 : opts.battery;
    this._online = false;
    this.calls = [];
    this.behavior = Object.assign({}, opts.behavior);
    this._codes = {}; // in-memory keypad slots for dev/dry-run keypad testing
  }

  get capabilities() {
    return new Set(['lock', 'unlock', 'state', 'battery', 'user_codes']);
  }

  // ---- Keypad codes (dev/dry-run only) ------------------------------------
  // Mirrors ZwaveLock's user-code surface so the full Keypad Users flow can be
  // exercised without a Z-Wave stick. Always "confirms"; drives no hardware.
  userCodesCapability() {
    return { supported: true, slots: 30, min_length: 4, max_length: 8, reserved_slots: [] };
  }

  async setUserCode(slot, code) {
    this.calls.push({ action: 'set_user_code', slot });
    this._codes[String(slot)] = String(code);
    return { slot, confirmed: true };
  }

  async clearUserCode(slot) {
    this.calls.push({ action: 'clear_user_code', slot });
    delete this._codes[String(slot)];
    return { slot, confirmed: true };
  }

  async rewriteUserCodes(saved) {
    this._codes = {};
    const results = [];
    for (const [slot, e] of Object.entries(saved || {})) {
      if (!e || !e.pin_code) continue;
      this._codes[String(slot)] = String(e.pin_code);
      results.push({ slot: Number(slot), ok: true });
    }
    return results;
  }

  async init() {
    this._online = !this.behavior.offline;
    if (this._online) this.emit('online');
  }

  async shutdown() {
    this._online = false;
  }

  async lock(reason) {
    return this._apply(LockState.LOCKED, 'lock', reason);
  }

  async unlock(reason) {
    return this._apply(LockState.UNLOCKED, 'unlock', reason);
  }

  async getState() {
    return this._snapshot();
  }

  /** Mirrors ZwaveLock.autoRelockInfo so the dashboard control works in dev. */
  autoRelockInfo() {
    return {
      supported: true,
      model_key: 'fake-lock',
      note: 'FakeLock: setting is recorded but drives no hardware',
      configured: this._autoRelock == null ? null : this._autoRelock,
    };
  }

  async setAutoRelock(enabled) {
    this.calls.push({ action: 'set_auto_relock', reason: enabled ? 'on' : 'off' });
    this._autoRelock = !!enabled;
    return { enabled: !!enabled, confirmed: true };
  }

  /** Synchronous snapshot (mirrors ZwaveLock.snapshot for getStatus callers). */
  snapshot() {
    return this._snapshot();
  }

  async _apply(target, action, reason) {
    this.calls.push({ action, reason: reason || null });
    if (this.behavior.offline) {
      this._online = false;
      return { success: false, boltState: this._state, error: 'offline' };
    }
    if (this.behavior.failNext) {
      this.behavior.failNext = false;
      return { success: false, boltState: this._state, error: 'command failed' };
    }
    if (this.behavior.jamOnLock && target === LockState.LOCKED) {
      this._state = LockState.JAMMED;
      this.emit('state-change', this._snapshot());
      return { success: false, boltState: this._state, error: 'jammed' };
    }
    this._state = target;
    this.emit('state-change', this._snapshot());
    return { success: true, boltState: this._state };
  }

  _snapshot() {
    return {
      boltState: this._state,
      battery: this._battery,
      online: this._online,
      lastSeen: null,
    };
  }
}

module.exports = FakeLock;
