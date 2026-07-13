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
 * controller listeners removed, inclusion/exclusion stopped best-effort, and
 * any pending PIN promise resolved false. The Z-Wave driver is deliberately
 * LEFT RUNNING after a session ends (success or failure): stopping it between
 * attempts created gaps in the zwave-js debug log, made quick retries race
 * Windows' slow serial-port release, and added no safety. The driver stops
 * only when the configured serial port changes or the app shuts down.
 *
 * Every step of a session is also recorded in this.history (and mirrored to
 * the app log with a [pairing] prefix) so a failed attempt can be diagnosed
 * from the dashboard or the diagnostics bundle without hunting files.
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

    // Rolling record of pairing steps across sessions (never reset with the
    // session, capped). Surfaced via status().history, the failed panel, and
    // the diagnostics bundle. Never contains the PIN.
    this.history = [];

    this._reset();
  }

  // Record a diagnostic step: appended to history AND mirrored to the app log
  // so every pairing action is captured even when the zwave-js driver (and
  // therefore its own debug log) is not running.
  _note(msg) {
    this.history.push({
      t: new Date(this.now()).toISOString(),
      mode: this.mode,
      state: this.state,
      msg: String(msg),
    });
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    this.logger.info && this.logger.info(`[pairing] ${msg}`);
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
      history: this.history.slice(-40),
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

  async _teardown({ stopRadio = true } = {}) {
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
    // The driver is intentionally left running (see the class comment): the
    // zwave-js debug log stays continuous across attempts and a retry never
    // races Windows' slow serial-port release. It stops only on a serial-path
    // change (_ensureFreshDriver) or app shutdown.
    this._note('session ended; the Z-Wave driver stays running for diagnostics and quick retries');
  }

  async _fail(reason) {
    if (!this.isActive()) return;
    this.error = reason;
    this.lastResult = 'failed';
    this._setState('failed');
    this._note(`FAILED: ${reason}`);
    this.logger.warn && this.logger.warn(`Z-Wave ${this.mode} failed: ${reason}`);
    await this._teardown();
  }

  async cancel(reason = 'cancelled by user') {
    if (!this.isActive()) return { status: 'idle' };
    this.error = null;
    this.lastResult = 'cancelled';
    this._setState('cancelled');
    this._note(`cancelled: ${reason}`);
    this.logger.info && this.logger.info(`Z-Wave ${this.mode} cancelled: ${reason}`);
    await this._teardown();
    return { status: 'cancelled' };
  }

  // Start (or reuse) the driver for the configured port, restarting it when
  // the configured serial path changed since the driver came up.
  async _ensureFreshDriver(zw) {
    if (this.manager.isRunning() && this.manager.serialPath
        && zw.serial_path && this.manager.serialPath !== zw.serial_path) {
      this._note(`serial port changed from ${this.manager.serialPath} to ${zw.serial_path}; restarting the Z-Wave driver`);
      await this.manager.stop();
    }
    await this.manager.ensureStarted({ serial_path: zw.serial_path, cache_dir: zw.cache_dir });
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
    this._note('PIN submitted (5 digits, not recorded); waiting for the S2 secure join to complete');
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
    if (candidates.length) {
      this._note(`checking ${candidates.length} leftover node${candidates.length === 1 ? '' : 's'} from earlier attempts (this can take a moment)...`);
    }
    for (const id of candidates) {
      try {
        if (await controller.isFailedNode(id)) {
          await controller.removeFailedNode(id);
          this._note(`removed ghost node ${id} left over from a failed pairing`);
        }
      } catch (e) {
        this._note(`could not remove ghost node ${id}: ${e.message}`);
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
      if (!this.isActive()) return this.status();

      const zw = this.getZwaveConfig() || {};
      this._note(`include session starting on ${zw.serial_path || 'unset port'} `
        + `(driver ${this.manager.isRunning() ? 'already running' : 'cold start'}, `
        + `S2 keys ${this._keysGenerated ? 'newly generated' : 'existing'})`);
      await this._ensureFreshDriver(zw);
      // The session may have been failed or cancelled while we awaited (e.g.
      // the stage timer fired). Never keep working a dead session: doing so
      // once produced a zombie that kept mutating state after failure.
      if (!this.isActive()) return this.status();

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
      //
      // Each ghost removal can take ~10s of radio work, so the stage timer is
      // suspended for the cleanup (zwave-js bounds each removal internally)
      // and re-armed fresh before the radio work begins. Five ghosts once ate
      // the whole 60s window and failed the session mid-cleanup.
      clearTimeout(this._timer);
      await this._cleanupGhostNodes(controller);
      if (!this.isActive()) return this.status();
      const foreignId = this._findForeignLiveNode(controller);
      if (foreignId != null) {
        throw new Error(
          `a device is already paired to this stick as node ${foreignId} (usually this lock, left over ` +
          'from an earlier attempt). Run Unpair and complete the exclusion sequence on the lock, then pair again.');
      }
      this._stage('starting', this.timeouts.starting,
        () => this._fail('the Z-Wave controller did not start in time'));

      // Snapshot the node ids present BEFORE inclusion so a node that appears
      // during this session can be recognized even if 'node added' never fires
      // (see _onProvisioningTimeout).
      this._preNodeIds = new Set();
      const preNodes = controller.nodes;
      if (preNodes && typeof preNodes.forEach === 'function') {
        preNodes.forEach((_n, id) => this._preNodeIds.add(id));
      }

      this._listen(controller, 'inclusion started', () => {
        if (!this.isActive()) return; // never resurrect a dead session
        this._note('controller radio is listening for the lock (inclusion started)');
        this._stage('waiting_for_device', this.timeouts.waiting,
          () => this._fail('no device entered inclusion mode; run the sequence on the lock and retry'));
      });

      // Log-only listeners: these events carry no state transition for us but
      // are the difference between "nothing happened" and a real diagnosis.
      this._listen(controller, 'node found', (found) => {
        this._note(`device answered the inclusion request (node ${found && found.id != null ? found.id : '?'}); starting the secure handshake`);
      });
      this._listen(controller, 'inclusion failed', () => {
        this._note("controller reported 'inclusion failed'");
      });
      this._listen(controller, 'inclusion stopped', () => {
        this._note('controller radio stopped listening (inclusion stopped)');
      });

      this._listen(controller, 'node added', (node, result) => {
        this._note(`node ${node && node.id} added (${result && result.lowSecurity ? 'WITHOUT full security' : 'secure'})`);
        Promise.resolve(this._onNodeAdded(node, result)).catch((e) =>
          this.logger.warn && this.logger.warn(`pairing node-added handler error: ${e.message}`));
      });

      const userCallbacks = {
        grantSecurityClasses: async (requested) => {
          this._note('lock requested security classes; granting as requested');
          return requested;
        },
        validateDSKAndEnterPIN: (dsk) => {
          this.dsk = dsk; // partial: zwave-js withholds the 5-digit PIN block
          this._note('lock identified (DSK received); waiting for the 5-digit PIN');
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
      if (!this.isActive()) {
        // The session died while beginInclusion was in flight; the radio may
        // now be listening with nobody driving it, so shut it down.
        try { if (typeof controller.stopInclusion === 'function') await controller.stopInclusion(); } catch (e) { /* best effort */ }
        return this.status();
      }
      if (accepted === false) {
        throw new Error('the controller is busy; wait a moment and try again');
      }
      this._note('inclusion request accepted by the controller');
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
      this._note(`exclude session starting on ${zw.serial_path || 'unset port'} `
        + `(driver ${this.manager.isRunning() ? 'already running' : 'cold start'})`);
      await this._ensureFreshDriver(zw);
      if (!this.isActive()) return this.status();

      const controller = this.manager.controller;
      if (!controller || typeof controller.beginExclusion !== 'function') {
        throw new Error('Z-Wave controller unavailable');
      }

      this._listen(controller, 'exclusion started', () => {
        if (!this.isActive()) return; // never resurrect a dead session
        this._note('controller radio is listening for the lock (exclusion started)');
        this._stage('waiting_for_device', this.timeouts.waiting,
          () => this._fail('no device entered exclusion mode; run the sequence on the lock and retry'));
      });

      this._listen(controller, 'node removed', (node) => {
        Promise.resolve(this._onNodeRemoved(node)).catch((e) =>
          this.logger.warn && this.logger.warn(`pairing node-removed handler error: ${e.message}`));
      });

      const accepted = await controller.beginExclusion();
      if (!this.isActive()) {
        try { if (typeof controller.stopExclusion === 'function') await controller.stopExclusion(); } catch (e) { /* best effort */ }
        return this.status();
      }
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
    await this._teardown({ stopRadio: true });
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
