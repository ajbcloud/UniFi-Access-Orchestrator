'use strict';

// S2 InclusionStrategy.Security_S2 in zwave-js (verified against v15.25.3).
// Hard-coded so this module never needs to require the native package.
const INCLUSION_STRATEGY_SECURITY_S2 = 4;

/**
 * One-at-a-time Z-Wave pairing (inclusion) / unpairing (exclusion) session,
 * driven by the dashboard through the /api/deadbolt/pair endpoints.
 *
 * States: idle -> starting -> waiting_for_device -> dsk_pending (include only)
 *         -> provisioning -> done | failed | cancelled (terminal).
 * Exclusion reuses the same slot with mode 'exclude' and no dsk/pin stages.
 *
 * Every terminal transition funnels through _teardown(): stage timer cleared,
 * controller listeners removed, inclusion/exclusion stopped best-effort, any
 * pending PIN promise resolved false, and the manager stopped ONLY when this
 * session started it and no lock driver is bound to it. A live lock keeps its
 * driver no matter how pairing ends.
 *
 * deps (all injectable for tests):
 *   manager             ZwaveManager (shared with the lock driver)
 *   logger              winston-like
 *   getZwaveConfig      () => config.devices.zwave (live getter)
 *   ensureKeysPersisted async () => {generated:boolean}; must persist any
 *                       newly-generated keys BEFORE inclusion starts
 *   onIncludeDone       async ({nodeId, securityClass}) => {}
 *   onExcludeDone       async ({nodeId}) => {}
 *   isLockBound         () => boolean (a lock driver currently uses the manager)
 *   timeouts            per-stage ms overrides (tests use small values)
 *   now                 () => ms epoch (injectable clock)
 */
class ZwavePairing {
  constructor(deps = {}) {
    this.manager = deps.manager;
    this.logger = deps.logger || console;
    this.getZwaveConfig = deps.getZwaveConfig || (() => ({}));
    this.ensureKeysPersisted = deps.ensureKeysPersisted || (async () => ({ generated: false }));
    this.onIncludeDone = deps.onIncludeDone || (async () => {});
    this.onExcludeDone = deps.onExcludeDone || (async () => {});
    this.isLockBound = deps.isLockBound || (() => false);
    this.now = deps.now || (() => Date.now());
    this.timeouts = Object.assign(
      // provisioning covers the full S2 bootstrap after the PIN (key exchange
      // plus the device interview), which can be slow on a battery lock at
      // range, so it gets a generous window. starting is 60s because Windows
      // can be slow to release the serial port after a previous session's
      // teardown, and a retry right after a failure must still succeed.
      { starting: 60000, waiting: 120000, dsk: 240000, provisioning: 180000, provisioning_grace: 60000 },
      deps.timeouts || {}
    );

    this._reset();
  }

  _reset() {
    this.mode = null;             // 'include' | 'exclude'
    this.state = 'idle';
    this.stateSince = this.now();
    this.dsk = null;              // partial DSK (PIN block withheld by zwave-js)
    this.nodeId = null;
    this.security = null;
    this.error = null;
    this.lastResult = null;       // 'done' | 'failed' | 'cancelled'
    this._timer = null;
    this._pinDeferred = null;
    this._listeners = [];         // [{emitter, event, fn}]
    this._startedManager = false;
    this._keysGenerated = false;
    this._preNodeIds = null;      // node ids present before inclusion started
    this._graceExtended = false;  // the one-time provisioning grace period
  }

  isActive() {
    return this.mode !== null && !['idle', 'done', 'failed', 'cancelled'].includes(this.state);
  }

  status() {
    return {
      active: this.isActive(),
      mode: this.mode,
      state: this.state,
      seconds_in_state: Math.max(0, Math.floor((this.now() - this.stateSince) / 1000)),
      dsk: this.state === 'dsk_pending' ? this.dsk : null,
      node_id: this.nodeId,
      security: this.security,
      error: this.error,
      last_result: this.lastResult,
      keys_generated: this._keysGenerated,
    };
  }

  _setState(state) {
    this.state = state;
    this.stateSince = this.now();
  }

  _stage(state, timeoutMs, onTimeout) {
    this._setState(state);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      Promise.resolve(onTimeout()).catch((e) =>
        this.logger.warn && this.logger.warn(`pairing timeout handler error: ${e.message}`));
    }, timeoutMs);
    if (this._timer.unref) this._timer.unref();
  }

  _listen(emitter, event, fn) {
    emitter.on(event, fn);
    this._listeners.push({ emitter, event, fn });
  }

  async _teardown({ stopRadio = true, keepManager = false } = {}) {
    clearTimeout(this._timer);
    this._timer = null;
    for (const { emitter, event, fn } of this._listeners) {
      if (typeof emitter.removeListener === 'function') emitter.removeListener(event, fn);
    }
    this._listeners = [];
    if (this._pinDeferred) {
      const d = this._pinDeferred;
      this._pinDeferred = null;
      d.resolve(false);
    }
    const controller = this.manager && this.manager.controller;
    if (stopRadio && controller) {
      try {
        if (this.mode === 'include' && typeof controller.stopInclusion === 'function') await controller.stopInclusion();
        if (this.mode === 'exclude' && typeof controller.stopExclusion === 'function') await controller.stopExclusion();
      } catch (e) { /* best effort */ }
    }
    // Stop the manager only if this session started it AND no lock uses it.
    // keepManager: a successful include is about to activate the lock on this
    // very driver, so leave it running for bringDeadboltOnline.
    if (this._startedManager && !keepManager && !this.isLockBound()) {
      try { await this.manager.stop(); } catch (e) { /* best effort */ }
    }
    this._startedManager = false;
  }

  async _fail(reason) {
    if (!this.isActive()) return;
    this.error = reason;
    this.lastResult = 'failed';
    this._setState('failed');
    this.logger.warn && this.logger.warn(`Z-Wave ${this.mode} failed: ${reason}`);
    await this._teardown();
  }

  async cancel(reason = 'cancelled by user') {
    if (!this.isActive()) return { status: 'idle' };
    this.error = null;
    this.lastResult = 'cancelled';
    this._setState('cancelled');
    this.logger.info && this.logger.info(`Z-Wave ${this.mode} cancelled: ${reason}`);
    await this._teardown();
    return { status: 'cancelled' };
  }

  submitPin(pin) {
    if (this.state !== 'dsk_pending' || !this._pinDeferred) {
      const err = new Error('Not waiting for a PIN');
      err.code = 'WRONG_STATE';
      throw err;
    }
    if (!/^\d{5}$/.test(String(pin || ''))) {
      const err = new Error('PIN must be exactly 5 digits');
      err.code = 'BAD_PIN';
      throw err;
    }
    const d = this._pinDeferred;
    this._pinDeferred = null;
    this._stage('provisioning', this.timeouts.provisioning,
      () => this._onProvisioningTimeout());
    d.resolve(String(pin));
    return { state: this.state };
  }

  // Node ids the config already claims (the paired lock). These are never
  // treated as ghosts or foreign devices.
  _configuredNodeIds() {
    const ids = new Set();
    const zw = this.getZwaveConfig() || {};
    const locks = zw.locks || {};
    for (const lock of Object.values(locks)) {
      if (lock && typeof lock.node_id === 'number' && lock.node_id > 0) ids.add(lock.node_id);
    }
    return ids;
  }

  // Remove dead entries left in the stick's node list by earlier aborted
  // pairing attempts. Only nodes the controller itself reports as failed are
  // removed, so a healthy device can never be deleted by accident.
  async _cleanupGhostNodes(controller) {
    const nodes = controller && controller.nodes;
    if (!nodes || typeof nodes.forEach !== 'function') return;
    if (typeof controller.isFailedNode !== 'function' || typeof controller.removeFailedNode !== 'function') return;
    const configured = this._configuredNodeIds();
    const candidates = [];
    nodes.forEach((_n, id) => {
      if (controller.ownNodeId != null && id === controller.ownNodeId) return;
      if (configured.has(id)) return;
      candidates.push(id);
    });
    for (const id of candidates) {
      try {
        if (await controller.isFailedNode(id)) {
          await controller.removeFailedNode(id);
          this.logger.info && this.logger.info(`Z-Wave: removed ghost node ${id} left over from a failed pairing`);
        }
      } catch (e) {
        this.logger.warn && this.logger.warn(`Z-Wave: could not remove ghost node ${id}: ${e.message}`);
      }
    }
  }

  // A live node that is neither the controller nor the configured lock. Its
  // presence means a previous join actually completed without the app knowing.
  _findForeignLiveNode(controller) {
    const nodes = controller && controller.nodes;
    if (!nodes || typeof nodes.forEach !== 'function') return null;
    const configured = this._configuredNodeIds();
    let found = null;
    nodes.forEach((_n, id) => {
      if (found != null) return;
      if (controller.ownNodeId != null && id === controller.ownNodeId) return;
      if (configured.has(id)) return;
      found = id;
    });
    return found;
  }

  // A node that appeared on the controller during this session but was not
  // there when inclusion started. Tolerates controllers without a nodes map.
  _findLateNode() {
    const controller = this.manager && this.manager.controller;
    const nodes = controller && controller.nodes;
    if (!nodes || typeof nodes.forEach !== 'function') return null;
    let found = null;
    nodes.forEach((node, id) => {
      if (found) return;
      if (controller.ownNodeId != null && id === controller.ownNodeId) return;
      if (this._preNodeIds && this._preNodeIds.has(id)) return;
      found = node;
    });
    return found;
  }

  // The provisioning timer fired without a 'node added' event. Failing blindly
  // here caused a nasty desync in the field: a slow lock could complete its
  // secure join AFTER our teardown removed the listeners, leaving the lock
  // paired at the radio level while the app reported failure and knew nothing
  // about the node. So before failing, look for a node that joined during this
  // session and adopt it (or wait one extra minute if it is still mid-join).
  async _onProvisioningTimeout() {
    const node = this._findLateNode();

    if (node && !this._graceExtended) {
      this._graceExtended = true;
      this.logger.info && this.logger.info(
        `Z-Wave include: node ${node.id} joined but the secure bootstrap has not finished; extending the wait`);
      this._stage('provisioning', this.timeouts.provisioning_grace, () => this._onProvisioningTimeout());
      return;
    }

    if (node) {
      const S2_ACCESS_CONTROL = 2; // zwave-js SecurityClass.S2_AccessControl
      let secClass = null;
      try {
        secClass = typeof node.getHighestSecurityClass === 'function'
          ? node.getHighestSecurityClass() : null;
      } catch (e) { /* security class not known yet */ }
      if (secClass === S2_ACCESS_CONTROL) {
        this.logger.warn && this.logger.warn(
          `Z-Wave include: 'node added' never fired but node ${node.id} joined with S2 Access Control; adopting it`);
        await this._onNodeAdded(node, { lowSecurity: false });
        return;
      }
      this.nodeId = node.id;
      await this._fail(
        `node ${node.id} joined but not with S2 Access Control (usually a wrong PIN or weak signal). ` +
        'Run Unpair to remove it, move the stick within a few feet of the lock, ' +
        'check the 5-digit PIN on the lock label, and pair again.');
      return;
    }

    await this._fail(
      'secure join timed out. If this keeps happening the lock may already think it is paired: ' +
      'run Unpair (exclusion) first, then redo the pairing sequence on the lock with the stick ' +
      'within a few feet. The Z-Wave debug log (Open Log Folder) has the full handshake.');
  }

  async startInclusion() {
    this._assertCanStart();
    this._reset();
    this.mode = 'include';
    this._stage('starting', this.timeouts.starting,
      () => this._fail('the Z-Wave controller did not start in time'));

    try {
      // Keys MUST exist and be persisted before any radio work: if the app
      // generated them now and crashed later, the paired lock would be
      // unreachable on the next boot.
      const kp = await this.ensureKeysPersisted();
      this._keysGenerated = !!(kp && kp.generated);

      const zw = this.getZwaveConfig() || {};
      const wasRunning = this.manager.isRunning();
      await this.manager.ensureStarted({ serial_path: zw.serial_path, cache_dir: zw.cache_dir });
      this._startedManager = !wasRunning;

      const controller = this.manager.controller;
      if (!controller || typeof controller.beginInclusion !== 'function') {
        throw new Error('Z-Wave controller unavailable');
      }

      // Recover from earlier failed sessions before touching the radio. Dead
      // ghost entries are removed automatically; a LIVE node that is neither
      // the controller nor the configured lock blocks inclusion with an
      // accurate message, because zwave-js silently aborts the join of an
      // already-included device ("Cannot add node N as it is already part of
      // the network") without emitting any event we could react to.
      await this._cleanupGhostNodes(controller);
      const foreignId = this._findForeignLiveNode(controller);
      if (foreignId != null) {
        throw new Error(
          `a device is already paired to this stick as node ${foreignId} (usually this lock, left over ` +
          'from an earlier attempt). Run Unpair and complete the exclusion sequence on the lock, then pair again.');
      }

      // Snapshot the node ids present BEFORE inclusion so a node that appears
      // during this session can be recognized even if 'node added' never fires
      // (see _onProvisioningTimeout).
      this._preNodeIds = new Set();
      const preNodes = controller.nodes;
      if (preNodes && typeof preNodes.forEach === 'function') {
        preNodes.forEach((_n, id) => this._preNodeIds.add(id));
      }

      this._listen(controller, 'inclusion started', () => {
        this._stage('waiting_for_device', this.timeouts.waiting,
          () => this._fail('no device entered inclusion mode; run the sequence on the lock and retry'));
      });

      this._listen(controller, 'node added', (node, result) => {
        Promise.resolve(this._onNodeAdded(node, result)).catch((e) =>
          this.logger.warn && this.logger.warn(`pairing node-added handler error: ${e.message}`));
      });

      const userCallbacks = {
        grantSecurityClasses: async (requested) => requested,
        validateDSKAndEnterPIN: (dsk) => {
          this.dsk = dsk; // partial: zwave-js withholds the 5-digit PIN block
          this._stage('dsk_pending', this.timeouts.dsk,
            () => this._fail('PIN entry timed out'));
          return new Promise((resolve) => { this._pinDeferred = { resolve }; });
        },
        abort: () => {
          this._fail('inclusion aborted by the controller (validation timed out)');
        },
      };

      const accepted = await controller.beginInclusion({
        strategy: INCLUSION_STRATEGY_SECURITY_S2,
        userCallbacks,
      });
      if (accepted === false) {
        throw new Error('the controller is busy; wait a moment and try again');
      }
      // Some stacks emit 'inclusion started' before/after beginInclusion
      // resolves; if it already fired, state moved on. Otherwise wait for it
      // under the 'starting' timer.
    } catch (err) {
      await this._fail(err.message);
      throw err;
    }
    return this.status();
  }

  async startExclusion() {
    this._assertCanStart();
    this._reset();
    this.mode = 'exclude';
    this._stage('starting', this.timeouts.starting,
      () => this._fail('the Z-Wave controller did not start in time'));

    try {
      const zw = this.getZwaveConfig() || {};
      const wasRunning = this.manager.isRunning();
      await this.manager.ensureStarted({ serial_path: zw.serial_path, cache_dir: zw.cache_dir });
      this._startedManager = !wasRunning;

      const controller = this.manager.controller;
      if (!controller || typeof controller.beginExclusion !== 'function') {
        throw new Error('Z-Wave controller unavailable');
      }

      this._listen(controller, 'exclusion started', () => {
        this._stage('waiting_for_device', this.timeouts.waiting,
          () => this._fail('no device entered exclusion mode; run the sequence on the lock and retry'));
      });

      this._listen(controller, 'node removed', (node) => {
        Promise.resolve(this._onNodeRemoved(node)).catch((e) =>
          this.logger.warn && this.logger.warn(`pairing node-removed handler error: ${e.message}`));
      });

      const accepted = await controller.beginExclusion();
      if (accepted === false) {
        throw new Error('the controller is busy; wait a moment and try again');
      }
    } catch (err) {
      await this._fail(err.message);
      throw err;
    }
    return this.status();
  }

  async _onNodeAdded(node, result) {
    if (!this.isActive()) return;
    if (result && result.lowSecurity) {
      // A BE469ZP joined without S2 cannot operate its Door Lock CC securely.
      // Fail loud with the recovery path rather than reporting success.
      this.nodeId = node && node.id;
      await this._fail('the lock joined WITHOUT S2 security (usually a wrong PIN or weak signal). Unpair it, move the stick close to the lock, and pair again.');
      return;
    }
    this.nodeId = node && node.id;
    this.security = 'S2 Access Control';
    this.lastResult = 'done';
    this._setState('done');
    this.logger.info && this.logger.info(`Z-Wave inclusion complete: node ${this.nodeId}`);
    await this._teardown({ stopRadio: true, keepManager: true });
    try {
      await this.onIncludeDone({ nodeId: this.nodeId, securityClass: this.security });
    } catch (err) {
      // Paired on the radio but the app could not persist/activate: surface it.
      this.lastResult = 'failed';
      this.state = 'failed';
      this.error = `paired as node ${this.nodeId} but activation failed: ${err.message}`;
    }
  }

  async _onNodeRemoved(node) {
    if (!this.isActive()) return;
    this.nodeId = node && node.id;
    this.lastResult = 'done';
    this._setState('done');
    this.logger.info && this.logger.info(`Z-Wave exclusion complete: node ${this.nodeId} removed`);
    await this._teardown({ stopRadio: true });
    try {
      await this.onExcludeDone({ nodeId: this.nodeId });
    } catch (err) {
      this.lastResult = 'failed';
      this.state = 'failed';
      this.error = `node ${this.nodeId} removed but cleanup failed: ${err.message}`;
    }
  }

  _assertCanStart() {
    if (this.isActive()) {
      const err = new Error('A pairing session is already active');
      err.code = 'ACTIVE';
      throw err;
    }
    const zw = this.getZwaveConfig() || {};
    if (!zw.serial_path) {
      const err = new Error('Set the Z-Wave serial port first (Configuration tab)');
      err.code = 'NO_PORT';
      throw err;
    }
  }
}

module.exports = { ZwavePairing, INCLUSION_STRATEGY_SECURITY_S2 };
