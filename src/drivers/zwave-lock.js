'use strict';

const { LockDriver, LockState } = require('./lock-driver');
const { ZwaveManager } = require('./zwave-manager');
const { loadSecurityKeys } = require('./zwave-keys');
const { SECURITY_CLASS_LABELS } = require('./zwave-pairing');
const lockCatalog = require('./lock-catalog');

// Z-Wave Door Lock CC (0x62) target modes. UNKNOWN (0xfe) is a legal
// currentMode in reports: the Schlage BE469ZP answers EVERY operation read
// with 0xfe and carries the true bolt position only in the report's
// boltStatus field (confirmed in field diagnostics).
const DOOR_LOCK_MODE = Object.freeze({ UNSECURED: 0x00, SECURED: 0xff, UNKNOWN: 0xfe });

// Notification CC (0x71) Access Control (type 6) event numbers of interest.
// Source: zwave-js Notifications registry. "Lock jammed" surfaces as a
// lock-state value 0x0b rather than a discrete event, but Schlage firmware has
// been observed to send it as an event arg too, so we treat 0x0b as a jam here.
// AUTO_LOCK (0x09) is how the BE469ZP announces its built-in auto-relock
// throwing the bolt ~30s after an unlock; it supports NO RF lock/unlock
// events (its supported list is 1, 2, 5, 6, 9, 11, 16, 18), so commanded
// moves never produce a notification at all.
const AC_NOTIFICATION = Object.freeze({
  MANUAL_LOCK: 0x01,
  MANUAL_UNLOCK: 0x02,
  RF_LOCK: 0x03,
  RF_UNLOCK: 0x04,
  KEYPAD_LOCK: 0x05,
  KEYPAD_UNLOCK: 0x06,
  AUTO_LOCK: 0x09,
  LOCK_JAMMED: 0x0b,
});

const LOCK_EVENTS = new Set([
  AC_NOTIFICATION.MANUAL_LOCK,
  AC_NOTIFICATION.RF_LOCK,
  AC_NOTIFICATION.KEYPAD_LOCK,
  AC_NOTIFICATION.AUTO_LOCK,
]);
const UNLOCK_EVENTS = new Set([
  AC_NOTIFICATION.MANUAL_UNLOCK,
  AC_NOTIFICATION.RF_UNLOCK,
  AC_NOTIFICATION.KEYPAD_UNLOCK,
]);

// Supervision CC result statuses (zwave-js SupervisionStatus). An S2 lock
// answers a supervised Door Lock set with one of these; SUCCESS means the
// lock itself confirmed the bolt finished moving, which is the fastest and
// strongest verification available (no need to wait for a separate report).
const SUPERVISION = Object.freeze({
  NO_SUPPORT: 0x00,
  WORKING: 0x01,
  FAIL: 0x02,
  SUCCESS: 0xff,
});

function modeToState(mode) {
  if (mode === DOOR_LOCK_MODE.SECURED) return LockState.LOCKED;
  if (mode === DOOR_LOCK_MODE.UNSECURED) return LockState.UNLOCKED;
  return LockState.UNKNOWN;
}

// Door Lock CC report boltStatus field -> LockState. On locks whose
// currentMode is useless (BE469ZP always answers 0xfe) this is the ONLY
// truthful position the report carries.
function boltToState(bolt) {
  if (bolt === 'locked') return LockState.LOCKED;
  if (bolt === 'unlocked') return LockState.UNLOCKED;
  return LockState.UNKNOWN;
}

// zwave-js NodeStatus enum (@zwave-js/core). For a battery lock, Asleep is the
// normal idle state and still counts as reachable; only Dead/Unknown mean the
// radio cannot deliver a frame right now.
const NODE_STATUS = Object.freeze({ UNKNOWN: 0, ASLEEP: 1, AWAKE: 2, DEAD: 3, ALIVE: 4 });

// Clean model names come from the shared lock catalog (src/lock-catalog.js),
// keyed by manufacturerId:productType:productId. The zwave-js device db labels
// the Yale ZW2 module with one combined multi-model string, so the catalog
// supplies deployment-clean names; anything unmapped falls back to the db
// label and then the raw ids, never a bare "unknown".

function hex4(n) {
  return '0x' + Number(n).toString(16).padStart(4, '0');
}

// Value ids for cache reads via node.getValue(): instant, never touch the
// wire, and return undefined until the interview has fetched them once.
const VALUE_ID_CURRENT_MODE = Object.freeze({ commandClass: 0x62, endpoint: 0, property: 'currentMode' });
const VALUE_ID_BOLT_STATUS = Object.freeze({ commandClass: 0x62, endpoint: 0, property: 'boltStatus' });
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
      // Identity: populated by _seedIdentity() once the interview has run
      // (cached across restarts by zwave-js). security_class is seeded from
      // config (persisted at pair time) until the node can confirm it.
      name: cfg.name || null,
      model: null,
      manufacturer: null,
      securityClass: cfg.security_class || null,
    };

    this.nodeId = cfg.node_id;
    this.verifyTimeoutMs = cfg.verify_timeout_ms == null ? 12000 : cfg.verify_timeout_ms;
    this.verifyRetries = cfg.verify_retries == null ? 1 : cfg.verify_retries;
    // Backoff before each retry (doubling per attempt): an immediate re-send
    // right after a failure tends to hit the same RF/queue condition.
    this.retryBackoffMs = cfg.retry_backoff_ms == null ? 1500 : cfg.retry_backoff_ms;
    // Early confirmation read inside the verify window. Field report: a test
    // unlock took 30+ seconds and still reported "not verified" because the
    // only fallback read happened AT the timeout, once per attempt. Locks
    // whose confirming report is lost (or that never send one) now get read
    // a couple of seconds in, so verification lands near the physical floor.
    this.earlyVerifyReadMs = cfg.early_verify_read_ms == null ? 2500 : cfg.early_verify_read_ms;
    // After a verification failure, keep watching for the wanted state a bit
    // longer. A slow lock that completes AFTER the verify window used to leave
    // a permanent "failed" record while the door visibly opened; the late
    // confirmation is emitted so the operator record can be corrected.
    this.lateConfirmMs = cfg.late_confirm_ms == null ? 45000 : cfg.late_confirm_ms;
    this.lowBatteryPct = cfg.low_battery_pct == null ? 25 : cfg.low_battery_pct;
    // Periodic bolt+battery refresh (minutes, 0 disables): event-driven state
    // is primary, but on an unattended box a silent drift (missed report,
    // stale cache) should be noticed within one poll interval, not at the
    // next entry event.
    this.pollMinutes = cfg.poll_minutes == null ? 20 : cfg.poll_minutes;
    this._pollTimer = null;
    this._wasBatteryLow = false;

    // Dead-node revival ladder (self-healing for an unattended box): while the
    // node reads Dead, ping it on a capped backoff forever. Base/cap are
    // configurable so tests run in milliseconds.
    this.reviveBaseMs = cfg.revive_base_ms == null ? 30000 : cfg.revive_base_ms;
    this.reviveMaxMs = cfg.revive_max_ms == null ? 600000 : cfg.revive_max_ms;
    this._reviveTimer = null;
    this._reviveAttempt = 0;
    this._lastRefreshInfoAt = 0;
    // Unknown-state recovery ladder: while the bolt reads UNKNOWN and the
    // node is reachable, re-read state and identity on a capped backoff.
    // Field report: the dashboard sat on "reading..." until the 20-minute
    // poll because nothing re-read state after a lost interview race.
    this.stateRecoveryBaseMs = cfg.state_recovery_base_ms == null ? 3000 : cfg.state_recovery_base_ms;
    this.stateRecoveryMaxMs = cfg.state_recovery_max_ms == null ? 300000 : cfg.state_recovery_max_ms;
    this._stateRecoveryTimer = null;
    this._stateRecoveryAttempt = 0;
    this._lateWatchCleanup = null;
    this._autoRelockApplied = false;
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
    this._seedIdentity();
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
    this._scheduleStateRecovery();
    this._maybeApplyAutoRelock();
    this._startPolling();
    this.emit(this._state.online ? 'online' : 'offline');
  }

  _startPolling() {
    if (this._pollTimer || !this.pollMinutes) return;
    this._pollTimer = setInterval(() => {
      // Only touch the wire when the node is reachable right now; a sleeping
      // lock re-seeds on its next wake anyway, and a dead one is the revival
      // ladder's job.
      if (!this._shouldLiveRead()) return;
      this._refreshLive().catch((err) => {
        this.logger.warn && this.logger.warn(`ZwaveLock: periodic state poll failed: ${err.message}`);
      });
    }, this.pollMinutes * 60000);
    if (typeof this._pollTimer.unref === 'function') this._pollTimer.unref();
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
      // The completion event also surfaces to the app: refreshInfo() resolves
      // when the interview is merely RE-QUEUED, so this is the only truthful
      // "re-interview finished" signal (operators used to test mid-interview).
      'interview completed': () => {
        this.emit('interview-completed', { node_id: this.nodeId });
        this._onNodeReady();
      },
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
    // System (type 9) event 1 "hardware failure": the BE469ZP sends this
    // (V1 alarm type 9) a few seconds after RF unlocks, even when the bolt
    // completes fine (field-observed). Surface it as an informational note,
    // never a state change and never an email alert: on this hardware it
    // usually means momentary bolt resistance, not a failure.
    if (args.type === 9 && args.event === 1) {
      this.logger.info && this.logger.info(
        'ZwaveLock: lock sent a system/hardware note (V1 alarm type 9); on the BE469ZP this usually means bolt resistance while the bolt still completed');
      this.emit('device-note', {
        code: 'system_hardware_note',
        detail: 'the lock reported possible bolt resistance during the last operation; check door alignment if the bolt did not fully move',
      });
      return;
    }
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
      // A non-definitive mode (the BE469ZP answers every read with 0xfe
      // "unknown") must never stomp a known bolt state; the same report's
      // boltStatus carries the truth and is handled below.
      this._updateStateFromReport(modeToState(args.newValue));
    }
    if (isDoorLock && args.property === 'boltStatus') {
      this._updateStateFromReport(boltToState(args.newValue));
    }
    const isBattery = args.commandClassName === 'Battery' || args.commandClass === 0x80;
    if (isBattery && args.property === 'level' && typeof args.newValue === 'number') {
      this._setBattery(args.newValue);
    }
  }

  /**
   * Apply a REPORT-derived reading (operation report / value cache). On
   * rf_verify:'optimistic' models a report may only RESOLVE an unknown state,
   * never overwrite a known one: the BE469ZP's report boltStatus is frozen at
   * "locked" regardless of the physical bolt, so letting it through would
   * stomp the real state on every poll. Notifications (manual/keypad/
   * auto-lock/jam) bypass this gate; they stay authoritative on all models.
   */
  _updateStateFromReport(st) {
    if (st === LockState.UNKNOWN) return;
    if (this._isOptimistic() && this._state.boltState !== LockState.UNKNOWN) return;
    this._updateState(st);
  }

  _updateState(boltState) {
    const prev = this._state.boltState;
    this._state.boltState = boltState;
    this._state.lastSeen = new Date().toISOString();
    // A definitive reading ends the unknown-state recovery ladder.
    if (boltState !== LockState.UNKNOWN) {
      this._stateRecoveryAttempt = 0;
      if (this._stateRecoveryTimer) {
        clearTimeout(this._stateRecoveryTimer);
        this._stateRecoveryTimer = null;
      }
    }
    this.emit('state-change', this.snapshot());
    // A jam is worth telling a human about even when no command is running
    // (a spontaneous jam used to only change the dashboard badge). Edge
    // triggered: one alert per transition into JAMMED.
    if (boltState === LockState.JAMMED && prev !== LockState.JAMMED) {
      this.emit('alert', {
        type: 'deadbolt_jammed',
        detail: 'lock reports the bolt jammed (obstruction); check door alignment and the bolt pocket',
      });
    }
  }

  _setBattery(level) {
    this._state.battery = level;
    this._state.batteryLow = level <= this.lowBatteryPct;
    this.emit('state-change', this.snapshot());
    // Edge triggered: one alert per crossing into low, re-armed on recovery,
    // so a battery sitting at 24% does not alert on every report (the
    // notifier's min-interval de-dupe is the second line of defense).
    if (this._state.batteryLow && !this._wasBatteryLow) {
      this.emit('alert', {
        type: 'deadbolt_low_battery',
        detail: `lock battery at ${level}% (threshold ${this.lowBatteryPct}%); replace the batteries soon`,
      });
    }
    this._wasBatteryLow = this._state.batteryLow;
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
    this._seedIdentity();
    this._seedFromCache();
    if (this._shouldLiveRead()) this._refreshLive().catch(() => { /* best effort */ });
    this._scheduleStateRecovery();
    this._maybeApplyAutoRelock();
  }

  /**
   * Model / manufacturer / security class off the node. All of these are
   * MaybeNotKnown until the Manufacturer Specific interview stage has run
   * once, then cached across restarts, so this is called from init AND the
   * ready/interview-completed/wake/alive handlers, exactly like the
   * bolt/battery re-seed. Display fallback chain: known profile -> device-db
   * label -> raw ids. Never writes a bare "unknown".
   */
  _seedIdentity() {
    const node = this._node;
    if (!node) return;
    let changed = false;
    const set = (key, val) => {
      if (val != null && val !== '' && this._state[key] !== val) {
        this._state[key] = val;
        changed = true;
      }
    };
    let dc = null;
    try { dc = node.deviceConfig || null; } catch (e) { dc = null; }
    const mfgId = typeof node.manufacturerId === 'number' ? node.manufacturerId : null;
    const prodType = typeof node.productType === 'number' ? node.productType : null;
    const prodId = typeof node.productId === 'number' ? node.productId : null;
    let model = null;
    if (mfgId != null && prodType != null && prodId != null) {
      model = lockCatalog.modelNameForIds(mfgId, prodType, prodId) || null;
    }
    if (!model && dc && dc.label) model = String(dc.label);
    if (!model && typeof node.label === 'string' && node.label) model = node.label;
    if (!model && mfgId != null && prodId != null) {
      model = `manufacturer ${hex4(mfgId)} product ${hex4(prodId)}`;
    }
    set('model', model);
    const manufacturer = (dc && dc.manufacturer)
      || (typeof node.manufacturer === 'string' ? node.manufacturer : null);
    set('manufacturer', manufacturer);
    try {
      const cls = typeof node.getHighestSecurityClass === 'function'
        ? node.getHighestSecurityClass() : null;
      if (typeof cls === 'number' && SECURITY_CLASS_LABELS[cls]) {
        set('securityClass', SECURITY_CLASS_LABELS[cls]);
      }
    } catch (e) { /* class not known yet */ }
    if (changed) this.emit('state-change', this.snapshot());
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
    this._seedIdentity();
    this._seedFromCache();
    if (this._shouldLiveRead()) this._refreshLive().catch(() => { /* best effort */ });
    this._scheduleStateRecovery();
    this._maybeApplyAutoRelock();
  }

  /**
   * Unknown-state recovery ladder. "reading..." on the dashboard is honest
   * for a few seconds after pairing, but nothing used to re-read state until
   * the 20-minute poll, so a lost interview race left it stuck for ages.
   * While the bolt is UNKNOWN: re-seed identity + cache every tick, and go to
   * the wire when the node is reachable, on a doubling backoff (base 3s,
   * capped at 5 min). The ladder dissolves the moment a definitive reading
   * lands (see _updateState) and never outlives shutdown().
   */
  _scheduleStateRecovery() {
    if (this._stateRecoveryTimer || this._stopped) return;
    if (this._state.boltState !== LockState.UNKNOWN) return;
    const delay = Math.min(
      this.stateRecoveryBaseMs * 2 ** this._stateRecoveryAttempt,
      this.stateRecoveryMaxMs
    );
    this._stateRecoveryAttempt++;
    this._stateRecoveryTimer = setTimeout(() => {
      this._stateRecoveryTimer = null;
      this._stateRecoveryTick().catch(() => { /* never throws into the timer */ });
    }, delay);
    if (typeof this._stateRecoveryTimer.unref === 'function') this._stateRecoveryTimer.unref();
  }

  async _stateRecoveryTick() {
    if (this._stopped) return;
    if (this._state.boltState !== LockState.UNKNOWN) {
      this._stateRecoveryAttempt = 0;
      return;
    }
    this._seedIdentity();
    this._seedFromCache();
    if (this._state.boltState === LockState.UNKNOWN && this._shouldLiveRead()) {
      try { await this._refreshLive(); } catch (e) { /* next rung retries */ }
    }
    if (this._state.boltState === LockState.UNKNOWN) this._scheduleStateRecovery();
    else this._stateRecoveryAttempt = 0;
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
    let st = mode != null ? modeToState(mode) : LockState.UNKNOWN;
    if (st === LockState.UNKNOWN) st = boltToState(node.getValue(VALUE_ID_BOLT_STATUS));
    this._updateStateFromReport(st);
    const level = node.getValue(VALUE_ID_BATTERY_LEVEL);
    if (typeof level === 'number') this._setBattery(level);
  }

  async _seedState() {
    const dl = this._doorLockCC();
    if (dl && typeof dl.get === 'function') {
      const rep = await dl.get();
      if (!rep) return;
      let st = rep.currentMode != null ? modeToState(rep.currentMode) : LockState.UNKNOWN;
      if (st === LockState.UNKNOWN) st = boltToState(rep.boltStatus);
      this._updateStateFromReport(st);
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
    // zwave-js returns a SupervisionResult when the set went out supervised
    // (and undefined otherwise); the caller uses SUCCESS as instant proof.
    return dl.set(mode);
  }

  _waitForState(wantState, timeoutMs) {
    return new Promise((resolve) => {
      if (this._state.boltState === wantState) return resolve(true);
      let done = false;
      const timers = [];
      const settle = (val) => {
        if (done) return;
        done = true;
        for (const t of timers) clearTimeout(t);
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
      // Early confirmation reads (doubling until the window closes). Locks
      // that confirm only when read - the BE469ZP sends NO notification for a
      // commanded move and its currentMode is always "unknown", so the only
      // confirmation is an operation read's boltStatus - used to sit out the
      // whole window and fail; now they verify a beat after the motor stops.
      // The reads feed _updateState, which lands in onChange above.
      if (this.earlyVerifyReadMs > 0) {
        for (let at = this.earlyVerifyReadMs; at < timeoutMs; at *= 2) {
          timers.push(setTimeout(() => {
            if (!done) this._seedState().catch(() => { /* next read or finish() decides */ });
          }, at));
        }
      }
      timers.push(setTimeout(finish, timeoutMs));
      this.on('state-change', onChange);
    });
  }

  // Deliberately a ref'd timer: it only exists inside an in-flight command,
  // and an unref'd sleep can drain the event loop mid-await (the process
  // would exit with the command's promise still pending).
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _setVerified(mode, wantState, action, reason) {
    let last = this._state.boltState;
    for (let attempt = 0; attempt <= this.verifyRetries; attempt++) {
      // Backoff before every retry (not the first attempt), doubling per
      // attempt: an instant re-send hits the same RF/queue condition that
      // just failed, so give the network a beat to clear.
      if (attempt > 0 && this.retryBackoffMs > 0) {
        await this._sleep(this.retryBackoffMs * 2 ** (attempt - 1));
      }
      let supervision = null;
      try {
        supervision = await this._commandSet(mode);
      } catch (err) {
        this.logger.warn && this.logger.warn(
          `ZwaveLock ${action} attempt ${attempt + 1} set error: ${err.message}`);
        continue;
      }
      const supStatus = supervision && typeof supervision.status === 'number' ? supervision.status : null;
      if (supStatus === SUPERVISION.SUCCESS) {
        // The lock itself confirmed the bolt finished moving: the strongest
        // and fastest verification there is, no report wait needed.
        this._updateState(wantState);
        return { success: true, boltState: this._state.boltState, verified: 'supervised' };
      }
      if (supStatus === SUPERVISION.FAIL) {
        // The lock explicitly refused/failed the motion: burning the whole
        // verify window on a report that will never confirm just adds ~12s
        // of dead time before the retry.
        this.logger.warn && this.logger.warn(
          `ZwaveLock ${action} attempt ${attempt + 1} rejected by the lock (supervision FAIL)`);
        last = this._state.boltState;
        continue;
      }
      // rf_verify:'optimistic' models (BE469ZP): there is no confirming
      // signal to wait for - reports are frozen, no RF notifications, and
      // supervision is disabled by the device DB. The set resolving means
      // the frame was delivered and acknowledged, which is the strongest
      // truth available; waiting used to turn every working unlock into a
      // 30-second false "failed".
      if (this._isOptimistic()) {
        this._updateState(wantState);
        this.logger.info && this.logger.info(
          `ZwaveLock ${action} delivered (optimistic verify: this model does not confirm remote moves)`);
        return { success: true, boltState: this._state.boltState, verified: 'optimistic' };
      }
      // WORKING, NO_SUPPORT, or an unsupervised send: wait for a confirming
      // report (with early reads inside the window).
      const ok = await this._waitForState(wantState, this.verifyTimeoutMs);
      last = this._state.boltState;
      if (ok) return { success: true, boltState: last, verified: 'report' };
      this.logger.warn && this.logger.warn(
        `ZwaveLock ${action} not confirmed (attempt ${attempt + 1}/${this.verifyRetries + 1}), state=${last}`);
    }
    this._watchLateConfirm(wantState, action);
    return { success: false, boltState: last, error: this._describeFailure() };
  }

  /**
   * After a verification failure, keep watching a little longer. A slow lock
   * that completes AFTER the verify window used to leave a permanent "failed"
   * record while the door visibly opened (field report); the late
   * confirmation is emitted so the operator record can be corrected. Only one
   * watch runs at a time: a newer command replaces an older watch.
   */
  _watchLateConfirm(wantState, action) {
    if (this.lateConfirmMs <= 0 || this._stopped) return;
    if (this._lateWatchCleanup) this._lateWatchCleanup();
    const startedAt = Date.now();
    const onChange = (snap) => {
      if (snap.boltState !== wantState) return;
      cleanup();
      const afterMs = Date.now() - startedAt;
      this.logger.info && this.logger.info(
        `ZwaveLock ${action} confirmed late, ${Math.round(afterMs / 1000)}s after the verify window closed`);
      this.emit('late-confirm', { action, boltState: snap.boltState, after_ms: afterMs });
    };
    const timer = setTimeout(() => cleanup(), this.lateConfirmMs);
    if (typeof timer.unref === 'function') timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      this.removeListener('state-change', onChange);
      if (this._lateWatchCleanup === cleanup) this._lateWatchCleanup = null;
    };
    this._lateWatchCleanup = cleanup;
    this.on('state-change', onChange);
  }

  /**
   * Turn a verification failure into something the operator can act on. The
   * node status says WHY the command went nowhere; a flat "not verified" sent
   * people hunting through logs (field report, node presumed dead mid-pair).
   */
  _describeFailure() {
    // A jam beats every link-level explanation: the radio worked, the bolt
    // physically could not move.
    if (this._state.boltState === LockState.JAMMED) {
      return 'the bolt is jammed (obstruction). Check the door alignment and the bolt pocket, then retry';
    }
    const st = this._nodeStatus();
    if (st === NODE_STATUS.DEAD || st === NODE_STATUS.UNKNOWN) {
      return 'lock not responding (Z-Wave reports the node dead). Wake it at the keypad; '
        + 'if it stays dead, move the controller closer to the lock or add a '
        + 'mains-powered Z-Wave device between them, then retry';
    }
    if (st === NODE_STATUS.ASLEEP) {
      return 'lock did not answer in time (it is asleep). Press the keypad to wake it, then retry';
    }
    return 'no confirmation from the lock within the wait window. If the bolt moved anyway, '
      + 'the dashboard updates as soon as its report arrives; a weak Z-Wave link (run Health Check) '
      + 'is the usual cause';
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

  /**
   * The lock's catalog profile, preferring the operator-chosen model_key
   * (persisted at pair time) and falling back to the interviewed node ids.
   */
  _modelProfile() {
    let prof = this.cfg.model_key ? lockCatalog.profileForKey(this.cfg.model_key) : null;
    if (!prof) {
      const n = this._node;
      if (n && typeof n.manufacturerId === 'number' && typeof n.productType === 'number'
          && typeof n.productId === 'number') {
        prof = lockCatalog.profileForIds(n.manufacturerId, n.productType, n.productId);
      }
    }
    return prof || null;
  }

  /**
   * True for models whose commanded moves cannot be verified from reports or
   * notifications (see lock-catalog rf_verify). For these, a transmitted
   * command is trusted as delivered and reports never overwrite known state.
   */
  _isOptimistic() {
    const prof = this._modelProfile();
    return !!(prof && prof.rf_verify === 'optimistic');
  }

  _configurationCC() {
    const cc = this._node && this._node.commandClasses;
    if (!cc) return null;
    return cc.Configuration || cc.configuration || null;
  }

  /**
   * Whether THIS lock's auto-relock is settable over Z-Wave, plus the saved
   * preference. Drives the dashboard's "After unlock" control; models without
   * a known parameter get the catalog's per-model note instead of a toggle.
   */
  autoRelockInfo() {
    const prof = this._modelProfile();
    const ar = (prof && prof.auto_relock) || null;
    return {
      supported: !!ar,
      model_key: prof ? prof.key : null,
      note: (prof && prof.auto_relock_note) || null,
      configured: this.cfg.auto_relock == null ? null : !!this.cfg.auto_relock,
    };
  }

  /**
   * Turn the lock's own auto-relock on or off by writing its configuration
   * parameter (e.g. Schlage BE469ZP parameter 15). "Stay unlocked" for an
   * office door is exactly auto-relock off: the ~30s re-throw after an unlock
   * is the LOCK's built-in feature, not this app. Values are read back to
   * confirm the write landed (best effort; some locks need a wake first).
   */
  async setAutoRelock(enabled) {
    if (!this._node) {
      throw new Error('Z-Wave driver is not running (stick unplugged or failed to start)');
    }
    const prof = this._modelProfile();
    const ar = prof && prof.auto_relock;
    if (!ar) {
      throw new Error((prof && prof.auto_relock_note)
        || 'this lock model does not expose auto-relock over Z-Wave; change it on the lock itself');
    }
    const cc = this._configurationCC();
    if (!cc || typeof cc.set !== 'function') {
      throw new Error('Configuration CC unavailable (run Re-interview / Heal, then retry)');
    }
    const value = enabled ? ar.on : ar.off;
    // valueFormat 1 = unsigned integer (zwave-js ConfigValueFormat), needed
    // because "on" values like 255 overflow a signed byte.
    await cc.set({ parameter: ar.parameter, value, valueSize: ar.size || 1, valueFormat: 1 });
    let confirmed = null;
    if (typeof cc.get === 'function') {
      try { confirmed = (await cc.get(ar.parameter)) === value; } catch (e) { confirmed = null; }
    }
    this.cfg.auto_relock = !!enabled; // keep autoRelockInfo truthful this run
    this.logger.info && this.logger.info(
      `ZwaveLock: auto-relock ${enabled ? 'enabled' : 'disabled'} `
      + `(parameter ${ar.parameter}=${value}`
      + `${confirmed == null ? '' : confirmed ? ', read-back confirmed' : ', READ-BACK MISMATCH'})`);
    return { enabled: !!enabled, confirmed };
  }

  /**
   * Re-apply the persisted auto-relock preference once per driver lifetime,
   * the first time the node is actually reachable. This is what makes the
   * preference survive restarts and re-pairing: the lock's parameter is
   * re-written from config, not assumed. Best effort: a failure re-arms so
   * the next ready/reachable event retries.
   */
  _maybeApplyAutoRelock() {
    if (this._autoRelockApplied || this._stopped) return;
    if (this.cfg.auto_relock == null) return;
    if (!this._shouldLiveRead()) return;
    const prof = this._modelProfile();
    if (!prof || !prof.auto_relock) return;
    this._autoRelockApplied = true;
    this.setAutoRelock(!!this.cfg.auto_relock).catch((err) => {
      this._autoRelockApplied = false;
      this.logger.warn && this.logger.warn(`ZwaveLock: re-applying auto-relock failed: ${err.message}`);
    });
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
    if (this._stateRecoveryTimer) {
      clearTimeout(this._stateRecoveryTimer);
      this._stateRecoveryTimer = null;
    }
    if (this._lateWatchCleanup) this._lateWatchCleanup();
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
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

module.exports = { ZwaveLock, DOOR_LOCK_MODE, AC_NOTIFICATION, SUPERVISION, modeToState, boltToState };
