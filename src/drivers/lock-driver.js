'use strict';

/**
 * Provider-agnostic lock actuator contract.
 *
 * The rules engine and orchestrator talk to this interface, never directly
 * to a concrete transport (UniFi REST, Z-Wave, a vendor cloud, etc). Concrete
 * drivers extend LockDriver. This is the "device driver seam" recommended in
 * the code review: it decouples the engine from any one lock technology and is
 * the point at which the actuation logic finally becomes unit-testable with a
 * fake driver.
 *
 * Scope note: on the UniFi side the orchestrator stays unlock-only, so no UniFi
 * door is ever driven through a LockDriver that exposes lock(). Only genuinely
 * two-way devices (the Z-Wave deadbolt) advertise the 'lock' capability.
 */

const { EventEmitter } = require('events');

/** Normalized, transport-agnostic bolt/lock states. */
const LockState = Object.freeze({
  LOCKED: 'locked',
  UNLOCKED: 'unlocked',
  JAMMED: 'jammed',
  UNKNOWN: 'unknown',
});

/**
 * @typedef {Object} LockSnapshot
 * @property {string} boltState   one of LockState
 * @property {number|null} battery  percent 0..100, or null if unknown
 * @property {boolean} online     driver currently connected to the device
 * @property {string|null} lastSeen  ISO timestamp of the last confirmed report
 */

/**
 * @typedef {Object} ActuateResult
 * @property {boolean} success    true only if the target state was verified
 * @property {string} boltState   observed state after the attempt
 * @property {string} [error]
 */

class LockDriver extends EventEmitter {
  /**
   * @returns {Set<string>} capability tokens, e.g. 'lock','unlock','state','battery'
   */
  get capabilities() {
    return new Set();
  }

  /** Connect/prepare the driver. Should be idempotent. */
  async init() {}

  /** Tear down cleanly (stop timers, close transport). */
  async shutdown() {}

  /**
   * Drive the bolt to LOCKED and verify it reached that state.
   * @param {string} [reason]
   * @returns {Promise<ActuateResult>}
   */
  async lock(reason) { // eslint-disable-line no-unused-vars
    throw new Error('lock() not implemented');
  }

  /**
   * Drive the bolt to UNLOCKED (retract) and verify it reached that state.
   * @param {string} [reason]
   * @returns {Promise<ActuateResult>}
   */
  async unlock(reason) { // eslint-disable-line no-unused-vars
    throw new Error('unlock() not implemented');
  }

  /** @returns {Promise<LockSnapshot>} */
  async getState() {
    return { boltState: LockState.UNKNOWN, battery: null, online: false, lastSeen: null };
  }
}

module.exports = { LockDriver, LockState };
