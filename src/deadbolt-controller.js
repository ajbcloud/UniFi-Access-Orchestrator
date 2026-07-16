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

const { scopeMatches } = require('./door-flows');

const REMOTE_PROVIDER = 'REMOTE_THROUGH_UAH';
const DEFAULT_DOORBELL_REASON_CODE = 107;

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
    // Resolve the acting user's group so a trigger's scope can gate the action.
    // Absent (older callers/tests) -> every action treats the user as
    // unresolved, and scope:null (everyone) still fires, so behavior is
    // unchanged until scoped triggers exist.
    this.resolveGroup = typeof deps.resolveGroup === 'function' ? deps.resolveGroup : null;

    const casc = config.cascade_rules || {};
    this.cascadeRules = (Array.isArray(casc.rules) ? casc.rules : []).map((r) => this._normalizeUnlockRule(r));
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
    this._cascadeTimers = new Set(); // pending delayed cascade unlocks (cleared on destroy)
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
      // Which event and who: a missing type is 'entry' and a missing scope is
      // everyone, so a legacy edge behaves exactly as before.
      type: edge.type === 'doorbell' ? 'doorbell' : 'entry',
      scope: edge.scope == null ? null : edge.scope,
      doorbell: edge.doorbell || null,
      after_unlock: ['lock_default', 'stay_unlocked', 'relock_after'].includes(edge.after_unlock)
        ? edge.after_unlock : 'lock_default',
      relock_seconds: edge.relock_seconds == null ? null : edge.relock_seconds,
      require_result: edge.require_result || 'ACCESS',
      mirror_unlock: !!edge.mirror_unlock,
      relock_cooldown_seconds: edge.relock_cooldown_seconds == null ? 10 : edge.relock_cooldown_seconds,
    };
  }

  // A cascade / scoped-unlock rule. A legacy rule ({trigger_door, unlock,
  // debounce_seconds}) becomes an everyone entry rule with no delay, so the
  // dedicated cascade controller behaves exactly as it did.
  _normalizeUnlockRule(r) {
    const rule = r || {};
    return {
      trigger_door: rule.trigger_door || null,
      trigger_door_id: rule.trigger_door_id || null,
      type: rule.type === 'doorbell' ? 'doorbell' : 'entry',
      scope: rule.scope == null ? null : rule.scope,
      doorbell: rule.doorbell || null,
      unlock: Array.isArray(rule.unlock) ? rule.unlock : [],
      debounce_seconds: rule.debounce_seconds == null ? 8 : rule.debounce_seconds,
      delay_seconds: rule.delay_seconds == null ? 0 : rule.delay_seconds,
    };
  }

  /** Clear timers and driver listeners. MUST be called before dropping the instance. */
  destroy() {
    this._destroyed = true;
    this._cancelRelock('controller destroyed');
    for (const t of this._cascadeTimers) clearTimeout(t);
    this._cascadeTimers.clear();
    if (this.lockDriver && typeof this.lockDriver.removeListener === 'function') {
      this.lockDriver.removeListener('state-change', this._onDriverStateChange);
    }
  }

  // ---- ingestion ---------------------------------------------------------

  observe(raw) {
    if (!this.enabled || this._destroyed || !raw || typeof raw !== 'object') return;
    const grant = this._parseAccessGrant(raw);
    if (grant) return this._onAccessGrant(grant);
    const bell = this._parseDoorbell(raw);
    if (bell) return this._onDoorbell(bell);
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
        actorId: actor.id || actor.user_id || null,
        actorName: actor.display_name || actor.name || null,
        credentialProvider: auth.credential_provider || null,
      };
    }
    // access.logs.insights.add is a parallel, flatter event newer firmware
    // emits alongside access.logs.add for the SAME tap. Handling it too would
    // double-fire retract and carries no direction and a weaker actor field, so
    // we intentionally ignore it and act only on the confirmed access.logs.add.
    if (type === 'access.logs.insights.add') return null;

    // Top-level webhook shape (event_source api_webhook): a bare
    // access.door.unlock with data.{location,actor,object}. Retract still needs
    // the websocket location.update, but the unlock/cascade path works in
    // webhook mode too now that the controller owns it.
    if (type === 'access.door.unlock' && raw.data) {
      const d = raw.data;
      const actor = d.actor || {};
      const obj = d.object || {};
      const loc = d.location || {};
      return {
        result: obj.result,
        doorName: loc.name || null,
        doorId: loc.id || null,
        direction: null,
        actorId: actor.id || actor.user_id || null,
        actorName: actor.name || actor.display_name || null,
        credentialProvider: (obj.credential_provider || obj.authentication_type) || null,
      };
    }

    // Alarm Manager envelope (event_source alarm_manager): {alarm:{name,triggers}}.
    if (raw.alarm && this._alarmType(raw) === 'access.door.unlock') {
      const a = raw.alarm;
      let actorId = null; let actorName = null;
      for (const t of (a.triggers || [])) {
        if (!actorId) actorId = (t.actor && t.actor.id) || t.user_id || t.actor_id || null;
        if (!actorName) actorName = (t.actor && (t.actor.name || t.actor.display_name)) || t.user_name || null;
      }
      if (!actorId) actorId = (a.actor && a.actor.id) || a.user_id || null;
      if (!actorName) actorName = (a.actor && (a.actor.name || a.actor.display_name)) || a.user_name || null;
      return {
        result: null, // alarm envelope carries no clean result; scoped unlocks do not gate on it
        doorName: a.name || null,
        doorId: null,
        direction: null,
        actorId,
        actorName,
        credentialProvider: null,
      };
    }
    return null;
  }

  // Infer the event type from Alarm Manager trigger keys (doorbell before door,
  // since "doorbell.completed" contains "door"). Only a key that actually says
  // UNLOCK counts as a grant: a denial / lockdown / held-open door alarm must
  // NOT be treated as an unlock (that would fire the cascade on a denial, since
  // the alarm envelope carries no result to gate on).
  _alarmType(raw) {
    for (const t of (raw.alarm && raw.alarm.triggers) || []) {
      const key = (t.key || '').toLowerCase();
      if (key.includes('doorbell') || key.includes('ring') || key.includes('intercom')) {
        return (key.includes('complete') || key.includes('answer')) ? 'access.doorbell.completed' : 'access.doorbell.incoming';
      }
      if (key.includes('unlock')) return 'access.door.unlock';
    }
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

  // A doorbell answer, from either the top-level webhook shape or an
  // access.logs.add wrapping access.doorbell.completed (websocket).
  _parseDoorbell(raw) {
    const type = raw.event || raw.type || '';
    if (type === 'access.doorbell.completed') {
      const data = raw.data || {};
      const obj = data.object || {};
      const loc = data.location || {};
      const actor = data.actor || {};
      const dev = data.device || {};
      return {
        reasonCode: obj.reason_code,
        doorName: loc.name || null,
        doorId: loc.id || null,
        actorId: actor.id || null,
        actorName: actor.name || actor.display_name || null,
        deviceName: dev.name || dev.alias || null,
      };
    }
    if (type === 'access.logs.add') {
      const s = raw.data && raw.data._source;
      if (!s) return null;
      const ev = s.event || {};
      if ((ev.type || '') !== 'access.doorbell.completed') return null;
      let doorName = null; let doorId = null; let deviceName = null;
      for (const t of s.target || []) {
        if (t.type === 'door') { doorName = t.display_name || t.name || doorName; doorId = t.id || doorId; }
        if (t.type === 'device') { deviceName = t.display_name || t.name || deviceName; }
      }
      const actor = s.actor || {};
      return {
        reasonCode: ev.reason_code,
        doorName,
        doorId,
        actorId: actor.id || actor.user_id || null,
        actorName: actor.display_name || actor.name || null,
        deviceName,
      };
    }
    if (raw.alarm && this._alarmType(raw) === 'access.doorbell.completed') {
      const a = raw.alarm;
      const trg = (a.triggers && a.triggers[0]) || {};
      return {
        reasonCode: (trg.reason_code != null ? trg.reason_code : DEFAULT_DOORBELL_REASON_CODE),
        doorName: a.name || null,
        doorId: null,
        actorId: (trg.actor && trg.actor.id) || trg.user_id || null,
        actorName: (trg.actor && (trg.actor.name || trg.actor.display_name)) || trg.user_name || null,
        deviceName: (a.sources && a.sources[0] && a.sources[0].device) || null,
      };
    }
    return null;
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

  /** The first edge matching the event door, or null. Used by the door-state
   *  path (lock-on-secured, mirror), which is per-door not per-user. */
  _edgeForEvent(doorName, doorId) {
    for (const edge of this.edges) {
      if (this._matchDoorSpec(doorName, doorId, edge.trigger_door, edge.trigger_door_id)) return edge;
    }
    return null;
  }

  /**
   * The first edge of a given type whose door matches, whose gate passes and
   * whose scope admits the resolved group. `group` is a lazy getter so the
   * resolver is only consulted when a scoped edge actually needs it.
   */
  _matchRetractEdge(type, doorName, doorId, gate, group) {
    for (const edge of this.edges) {
      if ((edge.type || 'entry') !== type) continue;
      if (!this._matchDoorSpec(doorName, doorId, edge.trigger_door, edge.trigger_door_id)) continue;
      if (!gate(edge)) continue;
      if (!scopeMatches(edge.scope, group())) continue;
      return edge;
    }
    return null;
  }

  /** Stable per-edge key for door state tracking. */
  _edgeKey(edge) {
    return edge.trigger_door_id ? `id:${edge.trigger_door_id}` : `name:${normName(edge.trigger_door)}`;
  }

  // A lazy group resolver for one event: consults deps.resolveGroup at most
  // once, and only when a scoped trigger asks. Unresolved -> null.
  _groupGetter(ev) {
    let group; let resolved = false;
    return () => {
      if (!resolved) {
        group = this.resolveGroup
          ? (this.resolveGroup({ actorId: ev.actorId || null, actorName: ev.actorName || null, deviceName: ev.deviceName || null }) || null)
          : null;
        resolved = true;
      }
      return group;
    };
  }

  _who(ev, group) {
    const name = ev.actorName || 'user';
    return group ? `${name} (${group})` : name;
  }

  _onAccessGrant(g) {
    if (this._isSelfTriggered(g)) {
      this.log.debug && this.log.debug('deadbolt: skipping self/remote-triggered event');
      return;
    }
    // Exits are not credential-tracked; if a reader ever reports exit, do nothing.
    if (g.direction === 'exit') return;

    const group = this._groupGetter(g);

    if (this.lockDriver) {
      // Per-edge result gate + scope: this door's entry edge decides which grant
      // results count and which groups it serves (legacy edges are ACCESS +
      // everyone, so behavior is unchanged).
      const edge = this._matchRetractEdge('entry', g.doorName, g.doorId,
        (e) => g.result === e.require_result, group);
      if (edge) this._retract(`entry: ${this._who(g, group())} at ${g.doorName}`, edge, { actor: this._who(g, group()), location: g.doorName });
    }
    // any_group is a FALLBACK (the migrated default_action's else-if): it fires
    // only when no group-specific unlock matched this group at this door.
    const entrySpecificMatched = this._specificGroupMatchedGetter('entry', g, group,
      () => g.result == null || g.result === this.requireResult);
    this.cascadeRules.forEach((rule, idx) => {
      if ((rule.type || 'entry') !== 'entry') return;
      if (!this._matchDoorSpec(g.doorName, g.doorId, rule.trigger_door, rule.trigger_door_id)) return;
      // A denied event must never fire an interior unlock, scoped or not.
      if (g.result != null && g.result !== this.requireResult) return;
      if (rule.scope && rule.scope.any_group && entrySpecificMatched()) return;
      if (!scopeMatches(rule.scope, group())) return;
      if (!this._debounceOk(rule, idx)) return;
      this._fireCascade(rule, g, group());
    });
  }

  // A lazy getter for "did a group-specific unlock rule of this type match the
  // resolved group at this event's door" (so an any_group fallback rule is
  // suppressed, matching the old default_action else-if semantics). Consults
  // the resolver at most once, and only when an any_group rule needs it.
  _specificGroupMatchedGetter(type, ev, group, gate) {
    let val; let done = false;
    return () => {
      if (!done) {
        const g0 = group();
        val = !!g0 && this.cascadeRules.some((r) => (r.type || 'entry') === type
          && r.scope && Array.isArray(r.scope.groups)
          && this._matchDoorSpec(ev.doorName, ev.doorId, r.trigger_door, r.trigger_door_id)
          && (!gate || gate(r))
          && scopeMatches(r.scope, g0));
        done = true;
      }
      return val;
    };
  }

  _onDoorbell(d) {
    // A doorbell answer is admin-initiated; the reason code is the gate (no
    // self-trigger/exit gating, mirroring the retired rules engine).
    if (d.reasonCode == null) return;
    const group = this._groupGetter(d);

    if (this.lockDriver) {
      const edge = this._matchRetractEdge('doorbell', d.doorName, d.doorId,
        (e) => this._doorbellReasonOk(e, d.reasonCode), group);
      if (edge) this._retract(`doorbell: ${this._who(d, group())} at ${d.doorName}`, edge, { actor: this._who(d, group()), location: d.doorName });
    }
    const bellSpecificMatched = this._specificGroupMatchedGetter('doorbell', d, group,
      (r) => this._doorbellReasonOk(r, d.reasonCode));
    this.cascadeRules.forEach((rule, idx) => {
      if ((rule.type || 'entry') !== 'doorbell') return;
      if (!this._matchDoorSpec(d.doorName, d.doorId, rule.trigger_door, rule.trigger_door_id)) return;
      if (!this._doorbellReasonOk(rule, d.reasonCode)) return;
      if (rule.scope && rule.scope.any_group && bellSpecificMatched()) return;
      if (!scopeMatches(rule.scope, group())) return;
      if (!this._debounceOk(rule, idx)) return;
      this._fireCascade(rule, d, group());
    });
  }

  _doorbellReasonOk(spec, reasonCode) {
    const want = (spec.doorbell && Number.isFinite(spec.doorbell.reason_code))
      ? spec.doorbell.reason_code : DEFAULT_DOORBELL_REASON_CODE;
    return reasonCode === want;
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

  _retract(reason, edge, ctx) {
    this._lastRetractAt = this.now(); // start the re-lock cooldown window
    if (edge) this._armAfterUnlock(edge, reason);
    Promise.resolve()
      .then(() => this.lockDriver.unlock(reason))
      .then((r) => {
        if (r && r.success) {
          this.stats.retracts++;
          this._record('retract', true, reason, ctx);
        } else {
          this.stats.retracts_failed++;
          this._record('retract', false, reason, ctx);
          // A failed retract blocks entry: higher severity.
          this.onAlert({ type: 'deadbolt_retract_failed', reason, state: r && r.boltState });
        }
      })
      .catch((err) => {
        this.stats.retracts_failed++;
        this._record('retract', false, `${reason} (${err.message})`, ctx);
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

  // Fire a cascade rule, honoring its optional delay. The delay timer is
  // tracked so destroy() can cancel a pending unlock (no leak, no double fire
  // after a rules reload).
  _fireCascade(rule, grant, group) {
    const ctx = { actor: this._who(grant, group), location: grant.doorName };
    const delayMs = (rule.delay_seconds || 0) * 1000;
    if (delayMs > 0) {
      const t = setTimeout(() => {
        this._cascadeTimers.delete(t);
        if (!this._destroyed) this._cascade(rule, grant, ctx);
      }, delayMs);
      if (typeof t.unref === 'function') t.unref();
      this._cascadeTimers.add(t);
    } else {
      this._cascade(rule, grant, ctx);
    }
  }

  _cascade(rule, grant, ctx) {
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
            this._record('cascade', true, `${grant.doorName} -> ${doorName}`, ctx);
          } else {
            this.stats.cascades_failed++;
            this._record('cascade', false, `${grant.doorName} -> ${doorName}`, ctx);
            this.onAlert({ type: 'cascade_failed', door: doorName, error: r && r.error });
          }
        })
        .catch((err) => {
          this.stats.cascades_failed++;
          this._record('cascade', false, `${doorName} (${err.message})`, ctx);
          this.onAlert({ type: 'cascade_failed', door: doorName, error: err.message });
        });
    }
  }

  _record(action, success, detail, ctx) {
    this.stats.last_action = { action, success, detail, time: new Date().toISOString() };
    if (this.broadcaster) {
      this.broadcaster({
        type: `deadbolt.${action}`,
        actor: (ctx && ctx.actor) || 'Deadbolt Controller',
        location: (ctx && ctx.location) || (this.edges[0] && this.edges[0].trigger_door) || '',
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
