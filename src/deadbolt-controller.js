'use strict';

/**
 * DeadboltController
 *
 * The Phase 2 event-to-action logic for the smart-deadbolt add-on. It observes
 * raw UniFi Access events (the same payloads the rules engine sees) and drives:
 *   - retract-on-entry: on an authorized entry at the front door, unlock (retract)
 *     the Z-Wave deadbolt so the person can get in;
 *   - lock-on-secured: when the front door transitions to "secured" (Double-Badge
 *     Override, Lock Now, or scheduled auto-lock), throw the deadbolt so it mirrors
 *     the mag-lock state;
 *   - interior cascade: on an authorized entry at the front door, momentarily
 *     unlock the interior door over the UniFi Access API (unlock-only) so the
 *     same walk-in continues through.
 *
 * It is deliberately independent of the rules engine's normalize/filter path
 * (the engine drops all data.* telemetry, which would swallow the location.update
 * lock signal), so it parses the raw payloads itself and is unit-testable with
 * captured fixtures. It never issues a lock command to the UniFi side.
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

    const db = config.deadbolt_rules || {};
    const casc = config.cascade_rules || {};
    this.deadbolt = db;
    this.triggerDoor = db.trigger_door || null;
    this.requireResult = db.require_result || 'ACCESS';
    this.mirrorUnlock = !!db.mirror_unlock; // retract on unsecured transition too (off by default)
    this.relockCooldownMs = (db.relock_cooldown_seconds == null ? 10 : db.relock_cooldown_seconds) * 1000;
    this.cascadeRules = Array.isArray(casc.rules) ? casc.rules : [];
    this.orchestratorActorName = normName(config.self_trigger_actor_name || 'Access Orchestrator');

    // enabled when there is something to do: a lock to drive, or a cascade rule
    this.enabled = !!(this.lockDriver || this.cascadeRules.length);

    this._lastLockState = null; // last observed front-door lock state
    this._lastRetractAt = 0; // ts of the last retract, for the re-lock cooldown
    this._cascadeLastFired = new Map(); // trigger door (normalized) -> ts
    this.stats = {
      retracts: 0,
      retracts_failed: 0,
      locks: 0,
      locks_failed: 0,
      cascades: 0,
      cascades_failed: 0,
      last_action: null,
    };
  }

  // ---- ingestion ---------------------------------------------------------

  observe(raw) {
    if (!this.enabled || !raw || typeof raw !== 'object') return;
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
      let direction = null;
      for (const t of s.target || []) {
        if (t.type === 'door') doorName = t.display_name || t.name || doorName;
        if (t.type === 'device_config' && t.id === 'door_entry_method') {
          direction = normName(t.display_name);
        }
      }
      return {
        result: ev.result,
        doorName,
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
    return { doorName: d.name || d.full_name || null, lock: state.lock };
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

  _onAccessGrant(g) {
    if (g.result !== this.requireResult) return;
    if (this._isSelfTriggered(g)) {
      this.log.debug && this.log.debug('deadbolt: skipping self/remote-triggered event');
      return;
    }
    // Exits are not credential-tracked; if a reader ever reports exit, do nothing.
    if (g.direction === 'exit') return;

    if (this.lockDriver && this._matchDoor(g.doorName, this.triggerDoor)) {
      this._retract(`entry: ${g.actorName || 'user'} at ${g.doorName}`);
    }
    this.cascadeRules.forEach((rule, idx) => {
      if (this._matchDoor(g.doorName, rule.trigger_door) && this._debounceOk(rule, idx)) {
        this._cascade(rule, g);
      }
    });
  }

  _onLocationUpdate(l) {
    if (!this.lockDriver || !this._matchDoor(l.doorName, this.triggerDoor)) return;
    const prev = this._lastLockState;
    this._lastLockState = l.lock;
    // Only act on an OBSERVED transition. A null prior state means this is the
    // first telemetry since startup: seed it, do not fire (avoids a spurious
    // lock/retract on boot).
    if (prev == null) return;
    if (l.lock === 'locked' && prev !== 'locked') {
      // Suppress an immediate re-lock right after an entry retract, in case a
      // normal entry's momentary mag-lock cycle emits a locked transition.
      if (this._lastRetractAt && (this.now() - this._lastRetractAt) < this.relockCooldownMs) {
        this.log.debug && this.log.debug('deadbolt: skip lock within retract cooldown');
        return;
      }
      this._lock('front door secured (mag lock)');
    } else if (this.mirrorUnlock && l.lock === 'unlocked' && prev !== 'unlocked') {
      this._retract('front door unsecured (schedule)');
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

  // ---- actions (fire-and-forget so ingestion never blocks) ---------------

  _retract(reason) {
    this._lastRetractAt = this.now(); // start the re-lock cooldown window
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
        location: this.triggerDoor || '',
        action: `${action}${success ? ' ok' : ' FAILED'}: ${detail}`,
        success,
      });
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      trigger_door: this.triggerDoor,
      last_lock_state: this._lastLockState,
      lock: this.lockDriver ? this.lockDriver.snapshot ? this.lockDriver.snapshot() : null : null,
      stats: Object.assign({}, this.stats),
    };
  }
}

module.exports = DeadboltController;
