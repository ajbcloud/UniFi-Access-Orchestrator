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

// zwave-js NodeStatus enum (@zwave-js/core). For a battery lock, Asleep is the
// normal idle state and still counts as reachable; only Dead/Unknown mean the
// radio cannot deliver a frame right now.
const NODE_STATUS = Object.freeze({ UNKNOWN: 0, ASLEEP: 1, AWAKE: 2, DEAD: 3, ALIVE: 4 });

// Value ids for cache reads via node.getValue(): instant, never touch the
// wire, and return undefined until the interview has fetched them once.
const VALUE_ID_CURRENT_MODE = Object.freeze({ commandClass: 0x62, endpoint: 0, property: 'currentMode' });
const VALUE_ID_BATTERY_LEVEL = Object.freeze({ commandClass: 0x80, endpoint: 0, property: 'level' });

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
    this._state = {
      boltState: LockState.UNKNOWN,
      battery: null,
      batteryLow: false,
      online: false,
      linkState: 'offline',
      lastSeen: null,
    };

    this.nodeId = cfg.node_id;
    this.verifyTimeoutMs = cfg.verify_timeout_ms == null ? 12000 : cfg.verify_timeout_ms;
    this.verifyRetries = cfg.verify_retries == null ? 1 : cfg.verify_retries;
    this.lowBatteryPct = cfg.low_battery_pct == null ? 25 : cfg.low_battery_pct;

    // Dead-node revival ladder (self-healing for an unattended box): while the
    // node reads Dead, ping it on a capped backoff forever. Base/cap are
    // configurable so tests run in milliseconds.
    this.reviveBaseMs = cfg.revive_base_ms == null ? 30000 : cfg.revive_base_ms;
    this.reviveMaxMs = cfg.revive_max_ms == null ? 600000 : cfg.revive_max_ms;
    this._reviveTimer = null;
    this._reviveAttempt = 0;
    this._lastRefreshInfoAt = 0;
    this._stopped = false;
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
    // Field report: init() runs the instant inclusion finishes, BEFORE the
    // node interview has populated the Door Lock CC. A live read here used to
    // reject with a misleading "does not support Door Lock" and nothing ever
    // re-read state, so the dashboard stuck at unknown/n-a/offline. Seed from
    // the value cache (instant, non-blocking), and only go to the wire when
    // the node is actually reachable; the lifecycle handlers in _wireNode
    // recover state when the interview completes or the lock wakes.
    this._refreshLink();
    this._seedFromCache();
    if (this._shouldLiveRead()) {
      try {
        await this._refreshLive();
      } catch (err) {
        this.logger.warn && this.logger.warn(`ZwaveLock: live state refresh failed: ${err.message}`);
      }
    }
    // A node that comes up Dead (e.g. it browned out during the pairing
    // interview) must start healing immediately, not wait for an operator.
    if (this._nodeStatus() === NODE_STATUS.DEAD) this._scheduleRevive();
    this.emit(this._state.online ? 'online' : 'offline');
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
      dead: () => this._onNodeDead(),
      alive: () => this._onNodeReachable(),
      // A battery lock only listens when awake; the moment it wakes is the
      // one chance to read it live, and 'ready'/'interview completed' mean
      // the value cache has just been (re)populated. These handlers are how
      // state recovers after the pairing-time interview race (see init()).
      'wake up': () => this._onNodeReachable(),
      ready: () => this._onNodeReady(),
      'interview completed': () => this._onNodeReady(),
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
      this._setBattery(args.newValue);
    }
  }

  _updateState(boltState) {
    this._state.boltState = boltState;
    this._state.lastSeen = new Date().toISOString();
    this.emit('state-change', this.snapshot());
  }

  _setBattery(level) {
    this._state.battery = level;
    this._state.batteryLow = level <= this.lowBatteryPct;
    this.emit('state-change', this.snapshot());
  }

  _setOnline(online) {
    if (this._state.online !== online) {
      this._state.online = online;
      this.emit(online ? 'online' : 'offline');
    }
  }

  /** node.status when the node exposes one (real zwave-js), else null. */
  _nodeStatus() {
    const n = this._node;
    return n && typeof n.status === 'number' ? n.status : null;
  }

  /**
   * Derive the link from node.status. Asleep is the normal idle state of a
   * battery deadbolt and still counts as UP (commands queue for its next
   * wake), so it must not read as "offline" or trip the offline alert.
   */
  _refreshLink() {
    const st = this._nodeStatus();
    let link;
    if (st == null) link = 'online'; // injected/test node exposes no status
    else if (st === NODE_STATUS.AWAKE || st === NODE_STATUS.ALIVE) link = 'online';
    else if (st === NODE_STATUS.ASLEEP) link = 'asleep';
    else link = 'offline'; // Dead or Unknown
    this._state.linkState = link;
    this._setOnline(link !== 'offline');
  }

  _onNodeDead() {
    this._state.linkState = 'offline';
    this._setOnline(false);
    this._scheduleRevive();
  }

  _onNodeReachable() {
    this._reviveAttempt = 0; // healed: next outage starts the ladder fresh
    this._refreshLink();
    this._seedFromCache();
    if (this._shouldLiveRead()) this._refreshLive().catch(() => { /* best effort */ });
  }

  /**
   * Dead-node revival ladder. The box is unattended, so nobody is around to
   * press Re-interview / Heal: ping the node on a capped backoff forever.
   * A successful ping makes zwave-js flip the node alive, which lands in
   * _onNodeReachable and re-seeds state; if the node was never fully
   * interviewed (the pairing-time brownout case) force a fresh interview,
   * rate-limited to once an hour so a flapping node cannot interview-storm.
   * The sustained offline monitor still alerts if the ladder keeps failing.
   */
  _scheduleRevive() {
    if (this._reviveTimer || this._stopped) return;
    const delay = Math.min(this.reviveBaseMs * 2 ** this._reviveAttempt, this.reviveMaxMs);
    this._reviveAttempt++;
    this._reviveTimer = setTimeout(() => {
      this._reviveTimer = null;
      this._reviveTick().catch(() => { /* never throws into the timer */ });
    }, delay);
    if (typeof this._reviveTimer.unref === 'function') this._reviveTimer.unref();
  }

  async _reviveTick() {
    if (this._stopped) return;
    const node = this._node;
    if (!node || this._nodeStatus() !== NODE_STATUS.DEAD) {
      this._reviveAttempt = 0;
      return;
    }
    let alive = false;
    if (typeof node.ping === 'function') {
      try { alive = await node.ping(); } catch (e) { alive = false; }
    }
    if (!alive) {
      this._scheduleRevive();
      return;
    }
    this.logger.info && this.logger.info(`ZwaveLock: node ${this.nodeId} revived by ping`);
    this._reviveAttempt = 0;
    this._onNodeReachable();
    if (node.ready !== true && typeof node.refreshInfo === 'function'
        && Date.now() - this._lastRefreshInfoAt > 3600000) {
      this._lastRefreshInfoAt = Date.now();
      this.logger.info && this.logger.info(`ZwaveLock: node ${this.nodeId} answered but was never fully interviewed; re-interviewing`);
      Promise.resolve(node.refreshInfo()).catch((e) => {
        this.logger.warn && this.logger.warn(`ZwaveLock: auto re-interview failed: ${e.message}`);
      });
    }
  }

  _onNodeReady() {
    this._refreshLink();
    this._seedFromCache();
    if (this._shouldLiveRead()) this._refreshLive().catch(() => { /* best effort */ });
  }

  /**
   * Live CC reads queue until a sleeping node wakes and would reject outright
   * on a dead one, so only go to the wire when the node is reachable now.
   * A node without a status (injected test node) is assumed reachable.
   */
  _shouldLiveRead() {
    if (!this._node) return false;
    if (this._node.ready === false) return false;
    const st = this._nodeStatus();
    if (st == null) return true;
    return st === NODE_STATUS.AWAKE || st === NODE_STATUS.ALIVE;
  }

  _doorLockCC() {
    const cc = this._node && this._node.commandClasses;
    if (!cc) return null;
    return cc['Door Lock'] || cc.doorLock || null;
  }

  _batteryCC() {
    const cc = this._node && this._node.commandClasses;
    if (!cc) return null;
    return cc.Battery || cc.battery || null;
  }

  /**
   * Seed bolt + battery from the zwave-js value cache: instant, never touches
   * the wire, and simply yields undefined for values the interview has not
   * fetched yet, so it is always safe to call.
   */
  _seedFromCache() {
    const node = this._node;
    if (!node || typeof node.getValue !== 'function') return;
    const mode = node.getValue(VALUE_ID_CURRENT_MODE);
    if (mode != null) this._updateState(modeToState(mode));
    const level = node.getValue(VALUE_ID_BATTERY_LEVEL);
    if (typeof level === 'number') this._setBattery(level);
  }

  async _seedState() {
    const dl = this._doorLockCC();
    if (dl && typeof dl.get === 'function') {
      const rep = await dl.get();
      if (rep && rep.currentMode != null) this._updateState(modeToState(rep.currentMode));
    }
  }

  async _readBattery() {
    const bat = this._batteryCC();
    if (bat && typeof bat.get === 'function') {
      const rep = await bat.get();
      if (rep && typeof rep.level === 'number') this._setBattery(rep.level);
    }
  }

  async _refreshLive() {
    await this._seedState();
    await this._readBattery();
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
    return { success: false, boltState: last, error: this._describeFailure() };
  }

  /**
   * Turn a verification failure into something the operator can act on. The
   * node status says WHY the command went nowhere; a flat "not verified" sent
   * people hunting through logs (field report, node presumed dead mid-pair).
   */
  _describeFailure() {
    const st = this._nodeStatus();
    if (st === NODE_STATUS.DEAD || st === NODE_STATUS.UNKNOWN) {
      return 'lock not responding (Z-Wave reports the node dead). Wake it at the keypad; '
        + 'if it stays dead, move the controller closer to the lock or add a '
        + 'mains-powered Z-Wave device between them, then retry';
    }
    if (st === NODE_STATUS.ASLEEP) {
      return 'lock did not answer in time (it is asleep). Press the keypad to wake it, then retry';
    }
    return 'not verified';
  }

  /**
   * Fail fast with the truth when the transport never came up: a null _node
   * used to surface as a generic "not verified" after two 12s windows, which
   * made a driver-side outage indistinguishable from a dead lock.
   */
  _preflightError() {
    if (!this._node) {
      return 'Z-Wave driver is not running (stick unplugged or failed to start). '
        + 'It retries automatically; check Download Diagnostics if this persists';
    }
    return null;
  }

  /** One immediate ping before commanding a Dead node: cheap revival chance. */
  async _preCommandRevive() {
    const node = this._node;
    if (this._nodeStatus() === NODE_STATUS.DEAD && node && typeof node.ping === 'function') {
      try { await node.ping(); } catch (e) { /* the set attempt will tell */ }
    }
  }

  async lock(reason) {
    const err = this._preflightError();
    if (err) return { success: false, boltState: this._state.boltState, error: err };
    await this._preCommandRevive();
    return this._setVerified(DOOR_LOCK_MODE.SECURED, LockState.LOCKED, 'lock', reason);
  }

  async unlock(reason) {
    const err = this._preflightError();
    if (err) return { success: false, boltState: this._state.boltState, error: err };
    await this._preCommandRevive();
    return this._setVerified(DOOR_LOCK_MODE.UNSECURED, LockState.UNLOCKED, 'unlock', reason);
  }

  /**
   * On-demand measured health: answers "why is it dropping" with numbers
   * instead of vibes. Every step is best-effort so a dead node still returns
   * a useful partial report. checkLifelineHealth(1) is a real RF probe and
   * can take a few seconds; callers should not hold a UI thread on it.
   */
  async healthCheck() {
    const node = this._node;
    if (!node) throw new Error('Z-Wave driver is not running');
    const out = {
      node_id: this.nodeId,
      status: this._nodeStatus(),
      link_state: this._state.linkState,
      ready: node.ready === true,
      last_seen: node.lastSeen || null,
    };
    if (typeof node.ping === 'function') {
      try { out.ping_ok = await node.ping(); } catch (e) { out.ping_ok = false; out.ping_error = e.message; }
    }
    const st = node.statistics;
    if (st) {
      out.statistics = {
        rtt_ms: st.rtt != null ? st.rtt : null,
        rssi_dbm: st.rssi != null ? st.rssi : null,
        route_repeaters: (st.lwr && Array.isArray(st.lwr.repeaters)) ? st.lwr.repeaters : null,
        commands_dropped_tx: st.commandsDroppedTX != null ? st.commandsDroppedTX : null,
        timeouts: st.timeoutResponse != null ? st.timeoutResponse : null,
      };
    }
    if (typeof node.checkLifelineHealth === 'function') {
      try {
        const h = await node.checkLifelineHealth(1);
        const r = (h && Array.isArray(h.results) && h.results[0]) || {};
        out.lifeline = {
          rating: h && h.rating != null ? h.rating : null, // 0..10, 10 best
          latency_ms: r.latency != null ? r.latency : null,
          neighbors: r.numNeighbors != null ? r.numNeighbors : null,
          failed_pings: r.failedPingsNode != null ? r.failedPingsNode : null,
          route_changes: r.routeChanges != null ? r.routeChanges : null,
          snr_margin_db: r.snrMargin != null ? r.snrMargin : null,
        };
      } catch (e) {
        out.lifeline_error = e.message;
      }
    }
    return out;
  }

  /**
   * Force a fresh interview (zwave-js refreshInfo): the in-app "heal" for a
   * node whose pairing-time interview died partway. NOT awaited to completion
   * by callers; on a sleeping lock it can take minutes and finishes on the
   * next wake. State recovers via the 'ready'/'interview completed' handlers.
   * Synchronous throw (not async) so route guards surface immediately while
   * the returned promise tracks the long-running interview itself.
   */
  reinterview() {
    const node = this._node;
    if (!node || typeof node.refreshInfo !== 'function') {
      throw new Error('re-interview unavailable (node not resolved yet)');
    }
    return Promise.resolve(node.refreshInfo());
  }

  async getState() {
    return this.snapshot();
  }

  snapshot() {
    return Object.assign({}, this._state);
  }

  async shutdown() {
    this._stopped = true;
    if (this._reviveTimer) {
      clearTimeout(this._reviveTimer);
      this._reviveTimer = null;
    }
    this._state.linkState = 'offline';
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
