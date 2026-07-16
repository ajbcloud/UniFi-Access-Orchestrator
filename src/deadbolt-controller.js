'use strict';

/**
 * DeadboltController
 *
 * The event-to-action logic for the smart-deadbolt add-on. It observes raw
 * UniFi Access events (the same payloads the rules engine sees) and drives:
 *   - retract-on-entry: on an authorized entry at a trigger door, unlock
 *     (retract) the Z-Wave deadbolt so the person can get in;
 *   - lock-on-secured: when a trigger door transitions to "secured"
 *     (Double-Badge Override, Lock Now, or scheduled auto-lock), throw the
 *     deadbolt so it mirrors the mag-lock state;
 *   - interior cascade: on an authorized entry at the trigger door,
 *     momentarily unlock the interior door(s) over the UniFi Access API
 *     (unlock-only) so the same walk-in continues through;
 *   - per-edge after-unlock: each door->deadbolt EDGE decides what happens
 *     after its retract - follow the lock's own hardware behavior
 *     ('lock_default'), hold open ('stay_unlocked'), or schedule an
 *     app-driven relock ('relock_after' N seconds, cancelled by any observed
 *     lock). Different doors may drive the SAME deadbolt differently.
 *
 * DOOR-CENTRIC INPUT (current): deps/config carry `edges` - the list of
 * door->this-lock edges from door_flows (see src/door-flows.js
 * edgesForLock). LEGACY INPUT (still supported; used by the dedicated
 * cascade controller and older tests): a single deadbolt_rules block, which
 * is synthesized into one edge with after_unlock 'lock_default' so behavior
 * is byte-for-byte what it was.
 *
 * It is deliberately independent of the rules engine's normalize/filter path
 * (the engine drops all data.* telemetry, which would swallow the
 * location.update lock signal), so it parses the raw payloads itself and is
 * unit-testable with captured fixtures. It never issues a lock command to
 * the UniFi side.
 *
 * LIFECYCLE: a controller may hold a pending relock timer and a listener on
 * the long-lived lock driver. Callers that rebuild controllers MUST call
 * destroy() on the old instance or timers/listeners leak and can double-fire
 * after a rules reload.
 *
 * Event shapes are grounded in captured evidence:
 *   - entry: access.logs.add wrapping _source (result in _source.event.result,
 *     actor in _source.actor, door + direction in _source.target[])
 *   - secured/unsecured: access.data.v2.location.update (or the legacy
 *     access.data.device.location_update_v2) with data.state.lock
 */

const REMOTE_PROVIDER = 'REMOTE_THROUGH_UAH';

function normName(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

class DeadboltController {
  constructor(config = {}, deps = {}) {
    this.log = deps.logger || console;
    this.lockDriver = deps.lockDriver || null;
    // Resolve the UniFi client lazily so a config reload (which rebuilds the
    // client) never leaves the cascade path holding a torn-down instance.
    this._getUnifi = deps.getUnifiClient || (() => deps.unifiClient || null);
    this.broadcaster = deps.broadcaster || null;
    this.onAlert = deps.onAlert || (() => {});
    this.now = deps.now || (() => Date.now());

    const casc = config.cascade_rules || {};
    this.cascadeRules = Array.isArray(casc.rules) ? casc.rules : [];
    this.orchestratorActorName = normName(config.self_trigger_actor_name || 'Access Orchestrator');

    // Door->lock edges. Preferred input: config.edges (door_flows). Legacy
    // input: a single deadbolt_rules block synthesized into one identical-
    // behavior edge ('lock_default' schedules nothing, matching the app's
    // historical no-relock-timer behavior).
    if (Array.isArray(config.edges)) {
      this.edges = config.edges.map((e) => this._normalizeEdge(e));
    } else {
      const db = config.deadbolt_rules || {};
      this.deadbolt = db;
      this.edges = db.trigger_door || db.trigger_door_id ? [this._normalizeEdge({
        trigger_door: db.trigger_door || null,
        trigger_door_id: db.trigger_door_id || null,
        after_unlock: 'lock_default',
        require_result: db.require_result,
        mirror_unlock: db.mirror_unlock,
        relock_cooldown_seconds: db.relock_cooldown_seconds,
      })] : [];
    }
    // Result gate for the CASCADE path (per-lock retract uses each edge's own
    // require_result). Matches the historical top-level default.
    this.requireResult = (config.deadbolt_rules && config.deadbolt_rules.require_result) || 'ACCESS';

    // enabled when there is something to do: a lock to drive, or a cascade rule
    this.enabled = !!((this.lockDriver && this.edges.length) || this.cascadeRules.length);

    this._lastLockStateByDoor = new Map(); // edge key -> last observed door lock state
    this._lastRetractAt = 0; // ts of the last retract, for the re-lock cooldown
    this._cascadeLastFired = new Map(); // trigger door (normalized) -> ts
    this._relockTimer = null;       // pending per-edge relock (at most one; last writer wins)
    this._relockEdge = null;        // the edge that armed the pending relock (for logs)
    this._destroyed = false;
    this.stats = {
      retracts: 0,
      retracts_failed: 0,
      locks: 0,
      locks_failed: 0,
      cascades: 0,
      cascades_failed: 0,
      last_action: null,
    };

    // Any observed bolt-locked (manual thumbturn, hardware auto-relock, our
    // own lock) cancels a pending app relock: the bolt is already where the
    // relock wanted it, and firing later could fight a fresh unlock.
    this._onDriverStateChange = (snap) => {
      if (snap && snap.boltState === 'locked') this._cancelRelock('bolt observed locked');
    };
    if (this.lockDriver && typeof this.lockDriver.on === 'function') {
      this.lockDriver.on('state-change', this._onDriverStateChange);
    }
  }

  _normalizeEdge(e) {
    const edge = e || {};
    return {
      trigger_door: edge.trigger_door || null,
      trigger_door_id: edge.trigger_door_id || null,
      after_unlock: ['lock_default', 'stay_unlocked', 'relock_after'].includes(edge.after_unlock)
        ? edge.after_unlock : 'lock_default',
      relock_seconds: edge.relock_seconds == null ? null : edge.relock_seconds,
      require_result: edge.require_result || 'ACCESS',
      mirror_unlock: !!edge.mirror_unlock,
      relock_cooldown_seconds: edge.relock_cooldown_seconds == null ? 10 : edge.relock_cooldown_seconds,
    };
  }

  /** Clear timers and driver listeners. MUST be called before dropping the instance. */
  destroy() {
    this._destroyed = true;
    this._cancelRelock('controller destroyed');
    if (this.lockDriver && typeof this.lockDriver.removeListener === 'function') {
      this.lockDriver.removeListener('state-change', this._onDriverStateChange);
    }
  }

  // ---- ingestion ---------------------------------------------------------

  observe(raw) {
    if (!this.enabled || this._destroyed || !raw || typeof raw !== 'object') return;
    const grant = this._parseAccessGrant(raw);
    if (grant) return this._onAccessGrant(grant);
    const loc = this._parseLocationUpdate(raw);
    if (loc) return this._onLocationUpdate(loc);
  }

  _parseAccessGrant(raw) {
    const type = raw.event || raw.type || '';
    if (type === 'access.logs.add') {
      const s = raw.data && raw.data._source;
      if (!s) return null;
      const ev = s.event || {};
      if ((ev.type || '') !== 'access.door.unlock') return null;
      const actor = s.actor || {};
      const auth = s.authentication || {};
      let doorName = null;
      let doorId = null;
      let direction = null;
      for (const t of s.target || []) {
        if (t.type === 'door') {
          doorName = t.display_name || t.name || doorName;
          doorId = t.id || doorId;
        }
        if (t.type === 'device_config' && t.id === 'door_entry_method') {
          direction = normName(t.display_name);
        }
      }
      return {
        result: ev.result,
        doorName,
        doorId,
        direction,
        actorName: actor.display_name || null,
        credentialProvider: auth.credential_provider || null,
      };
    }
    // access.logs.insights.add is a parallel, flatter event newer firmware
    // emits alongside access.logs.add for the SAME tap. Handling it too would
    // double-fire retract and carries no direction and a weaker actor field, so
    // we intentionally ignore it and act only on the confirmed access.logs.add.
    return null;
  }

  _parseLocationUpdate(raw) {
    const type = raw.event || raw.type || '';
    if (type !== 'access.data.v2.location.update' &&
        type !== 'access.data.device.location_update_v2') {
      return null;
    }
    const d = raw.data || {};
    if ((d.location_type || '') !== 'door') return null;
    const state = d.state || {};
    if (!state.lock) return null;
    return { doorName: d.name || d.full_name || null, doorId: d.unique_id || d.id || null, lock: state.lock };
  }

  // ---- decisions ---------------------------------------------------------

  _isSelfTriggered(grant) {
    if (grant.credentialProvider === REMOTE_PROVIDER) return true;
    if (grant.actorName && normName(grant.actorName) === this.orchestratorActorName) return true;
    return false;
  }

  _matchDoor(eventName, configName) {
    if (!eventName || !configName) return false;
    return normName(eventName) === normName(configName);
  }

  // Prefer a door id match (survives a UniFi rename) when both the event and
  // the rule carry an id; otherwise fall back to the name match, so behavior is
  // unchanged until ids are backfilled onto the rules.
  _matchDoorSpec(eventName, eventId, ruleName, ruleId) {
    if (ruleId && eventId) return String(ruleId) === String(eventId);
    return this._matchDoor(eventName, ruleName);
  }

  /** The first edge matching the event door, or null. */
  _edgeForEvent(doorName, doorId) {
    for (const edge of this.edges) {
      if (this._matchDoorSpec(doorName, doorId, edge.trigger_door, edge.trigger_door_id)) return edge;
    }
    return null;
  }

  /** Stable per-edge key for door state tracking. */
  _edgeKey(edge) {
    return edge.trigger_door_id ? `id:${edge.trigger_door_id}` : `name:${normName(edge.trigger_door)}`;
  }

  _onAccessGrant(g) {
    if (this._isSelfTriggered(g)) {
      this.log.debug && this.log.debug('deadbolt: skipping self/remote-triggered event');
      return;
    }
    // Exits are not credential-tracked; if a reader ever reports exit, do nothing.
    if (g.direction === 'exit') return;

    if (this.lockDriver) {
      const edge = this._edgeForEvent(g.doorName, g.doorId);
      // Per-edge result gate: this door's edge decides which grant results
      // count (legacy default ACCESS carried onto the synthesized edge).
      if (edge && g.result === edge.require_result) {
        this._retract(`entry: ${g.actorName || 'user'} at ${g.doorName}`, edge);
      }
    }
    if (g.result === this.requireResult) {
      this.cascadeRules.forEach((rule, idx) => {
        if (this._matchDoorSpec(g.doorName, g.doorId, rule.trigger_door, rule.trigger_door_id) && this._debounceOk(rule, idx)) {
          this._cascade(rule, g);
        }
      });
    }
  }

  _onLocationUpdate(l) {
    if (!this.lockDriver) return;
    const edge = this._edgeForEvent(l.doorName, l.doorId);
    if (!edge) return;
    const key = this._edgeKey(edge);
    const prev = this._lastLockStateByDoor.get(key);
    this._lastLockStateByDoor.set(key, l.lock);
    // Only act on an OBSERVED transition. An undefined prior state means this
    // is the first telemetry since startup: seed it, do not fire (avoids a
    // spurious lock/retract on boot).
    if (prev == null) return;
    if (l.lock === 'locked' && prev !== 'locked') {
      // The door is secured: a pending app relock is now redundant (and could
      // fight a later unlock), so cancel it regardless of the cooldown below.
      this._cancelRelock(`door secured (${l.doorName})`);
      // Suppress an immediate re-lock right after an entry retract, in case a
      // normal entry's momentary mag-lock cycle emits a locked transition.
      // The window comes from the EDGE that owns this door.
      const cooldownMs = edge.relock_cooldown_seconds * 1000;
      if (this._lastRetractAt && (this.now() - this._lastRetractAt) < cooldownMs) {
        this.log.debug && this.log.debug('deadbolt: skip lock within retract cooldown');
        return;
      }
      this._lock(`door secured (mag lock): ${l.doorName}`);
    } else if (edge.mirror_unlock && l.lock === 'unlocked' && prev !== 'unlocked') {
      this._retract(`door unsecured (schedule): ${l.doorName}`, edge);
    }
  }

  _debounceOk(rule, idx) {
    // Key per rule (index + door), not by door alone, so two rules sharing a
    // trigger door debounce independently instead of one silently suppressing
    // the other on the same entry.
    const key = idx + ':' + normName(rule.trigger_door);
    const windowMs = (rule.debounce_seconds == null ? 8 : rule.debounce_seconds) * 1000;
    const last = this._cascadeLastFired.get(key);
    const nowTs = this.now();
    if (last != null && nowTs - last < windowMs) return false;
    this._cascadeLastFired.set(key, nowTs);
    return true;
  }

  // ---- per-edge after-unlock orchestration --------------------------------

  /**
   * Arm the after-unlock behavior of the edge that just retracted. LAST
   * WRITER WINS: two doors triggering the same lock near-simultaneously each
   * clear the previous pending relock and apply their own edge's intent -
   * the most recent entry is the most recent human intent.
   */
  _armAfterUnlock(edge, reason) {
    this._cancelRelock('superseded by a newer retract');
    if (this._destroyed) return;
    if (edge.after_unlock === 'relock_after'
        && Number.isFinite(edge.relock_seconds) && edge.relock_seconds > 0) {
      this._relockEdge = edge;
      this._relockTimer = setTimeout(
        () => this._fireRelock(edge, reason),
        edge.relock_seconds * 1000
      );
      if (typeof this._relockTimer.unref === 'function') this._relockTimer.unref();
    }
    // 'lock_default': schedule nothing; the lock's own hardware timer (if
    // any) acts. 'stay_unlocked': schedule nothing AND the cancel above
    // cleared any pending relock; if the lock's HARDWARE auto-relock is on
    // the API layer warns the operator (the app never fights the hardware).
  }

  _cancelRelock(why) {
    if (this._relockTimer) {
      clearTimeout(this._relockTimer);
      this._relockTimer = null;
      this._relockEdge = null;
      this.log.debug && this.log.debug(`deadbolt: pending relock cancelled (${why})`);
    }
  }

  _fireRelock(edge, reason) {
    this._relockTimer = null;
    this._relockEdge = null;
    if (this._destroyed) return;
    // Belt-and-suspenders: if anything already threw the bolt (hardware
    // auto-relock, manual thumbturn), do nothing.
    try {
      const snap = this.lockDriver && typeof this.lockDriver.snapshot === 'function'
        ? this.lockDriver.snapshot() : null;
      if (snap && snap.boltState === 'locked') return;
    } catch (e) { /* snapshot unavailable: proceed with the lock attempt */ }
    this._lock(`edge relock after ${edge.relock_seconds}s (${reason})`);
  }

  // ---- actions (fire-and-forget so ingestion never blocks) ---------------

  _retract(reason, edge) {
    this._lastRetractAt = this.now(); // start the re-lock cooldown window
    if (edge) this._armAfterUnlock(edge, reason);
    Promise.resolve()
      .then(() => this.lockDriver.unlock(reason))
      .then((r) => {
        if (r && r.success) {
          this.stats.retracts++;
          this._record('retract', true, reason);
        } else {
          this.stats.retracts_failed++;
          this._record('retract', false, reason);
          // A failed retract blocks entry: higher severity.
          this.onAlert({ type: 'deadbolt_retract_failed', reason, state: r && r.boltState });
        }
      })
      .catch((err) => {
        this.stats.retracts_failed++;
        this._record('retract', false, `${reason} (${err.message})`);
        this.onAlert({ type: 'deadbolt_retract_failed', reason, error: err.message });
      });
  }

  _lock(reason) {
    Promise.resolve()
      .then(() => this.lockDriver.lock(reason))
      .then((r) => {
        if (r && r.success) {
          this.stats.locks++;
          this._record('lock', true, reason);
        } else {
          this.stats.locks_failed++;
          this._record('lock', false, reason);
          // A failed lock is backstopped by the Schlage auto-lock: lower severity.
          this.onAlert({ type: 'deadbolt_lock_failed', reason, state: r && r.boltState });
        }
      })
      .catch((err) => {
        this.stats.locks_failed++;
        this._record('lock', false, `${reason} (${err.message})`);
        this.onAlert({ type: 'deadbolt_lock_failed', reason, error: err.message });
      });
  }

  _cascade(rule, grant) {
    const doors = Array.isArray(rule.unlock) ? rule.unlock : [];
    const client = this._getUnifi();
    for (const doorName of doors) {
      Promise.resolve()
        .then(() => client
          ? client.unlockDoorByName(doorName, `cascade from ${grant.doorName}`)
          : { success: false, error: 'no unifi client' })
        .then((r) => {
          if (r && r.success) {
            this.stats.cascades++;
            this._record('cascade', true, `${grant.doorName} -> ${doorName}`);
          } else {
            this.stats.cascades_failed++;
            this._record('cascade', false, `${grant.doorName} -> ${doorName}`);
            this.onAlert({ type: 'cascade_failed', door: doorName, error: r && r.error });
          }
        })
        .catch((err) => {
          this.stats.cascades_failed++;
          this._record('cascade', false, `${doorName} (${err.message})`);
          this.onAlert({ type: 'cascade_failed', door: doorName, error: err.message });
        });
    }
  }

  _record(action, success, detail) {
    this.stats.last_action = { action, success, detail, time: new Date().toISOString() };
    if (this.broadcaster) {
      this.broadcaster({
        type: `deadbolt.${action}`,
        actor: 'Deadbolt Controller',
        location: (this.edges[0] && this.edges[0].trigger_door) || '',
        action: `${action}${success ? ' ok' : ' FAILED'}: ${detail}`,
        success,
      });
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      // Compat: trigger_door stays the first edge's door; trigger_doors is
      // the full multi-door list.
      trigger_door: (this.edges[0] && this.edges[0].trigger_door) || null,
      trigger_doors: this.edges.map((e) => e.trigger_door).filter(Boolean),
      relock_pending: !!this._relockTimer,
      last_lock_state: this.edges[0]
        ? (this._lastLockStateByDoor.get(this._edgeKey(this.edges[0])) ?? null)
        : null,
      lock: this.lockDriver ? this.lockDriver.snapshot ? this.lockDriver.snapshot() : null : null,
      stats: Object.assign({}, this.stats),
    };
  }
}

module.exports = DeadboltController;
