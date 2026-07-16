'use strict';

/**
 * door_flows: the door-centric automation shape (pure, unit-testable).
 *
 * Product model: "everything starts at the door." Configuring a door answers
 * one question - when entry is granted here, what happens? - with two kinds
 * of consequences:
 *   retract: real Z-Wave lock commands to one or more deadbolts, each edge
 *            carrying its OWN after-unlock behavior and advanced fields
 *            (one door may make a deadbolt behave differently than another);
 *   cascade: momentary UniFi unlocks of OTHER doors (never a lock command).
 *
 * Canonical persisted shape (replaces deadbolt_rules + cascade_rules on disk):
 *   door_flows: {
 *     "<door name>": {
 *       door_id: "abc123" | null,      // rename-proof id, backfilled lazily
 *       retract: [ {
 *         lock_id: "front_deadbolt",
 *         after_unlock: 'lock_default' | 'stay_unlocked' | 'relock_after',
 *         relock_seconds: 30,          // only meaningful for relock_after
 *         require_result: 'ACCESS',
 *         mirror_unlock: false,
 *         relock_cooldown_seconds: 10, // lock-on-secured suppression window
 *       } ],
 *       cascade: { unlock: ["Interior Door"],
 *                  unlock_ids: ["def456"|null,...], // parallel ids, optional
 *                  debounce_seconds: 8 } | null
 *     }, ...
 *   }
 *
 * Door KEYS remain display names (readable configs, same matching contract
 * as the old trigger_door); each flow carries door_id so controller matching
 * and access gating survive a UniFi rename, mirroring the trigger_door_id
 * mechanism that deadbolt_rules gained.
 *
 * MIGRATION INVARIANT (the #1 correctness rule): a migrated legacy config
 * must behave IDENTICALLY to today. That means after_unlock defaults to
 * 'lock_default' (the app schedules nothing; only the lock's own hardware
 * timer acts) and require_result / mirror_unlock / relock_cooldown_seconds /
 * cascade debounce carry over with their existing defaults.
 */

const deadboltRules = require('./deadbolt-rules');

const AFTER_UNLOCK_MODES = Object.freeze(['lock_default', 'stay_unlocked', 'relock_after']);

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeKey(k) { return !UNSAFE_KEYS.has(k); }
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** Normalized (case-insensitive, trimmed) door-name comparison key. */
function normName(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

/**
 * Migrate {deadbolt_rules, cascade_rules} to door_flows.
 * Returns { changed, flows }. Idempotent: a config already carrying a
 * plain-object door_flows passes through unchanged and WINS over any legacy
 * keys still present (they are stale by definition once flows exist).
 */
function migrateToFlows(cfg, locks) {
  const c = cfg || {};
  if (isPlainObject(c.door_flows)) return { changed: false, flows: c.door_flows };
  const hasLegacy = isPlainObject(c.deadbolt_rules) || isPlainObject(c.cascade_rules);
  if (!hasLegacy) return { changed: false, flows: {} };

  const flows = {};
  const flowFor = (doorName, doorId) => {
    const key = String(doorName).trim();
    if (!flows[key]) flows[key] = { door_id: doorId || null, retract: [], cascade: null };
    else if (doorId && !flows[key].door_id) flows[key].door_id = doorId;
    return flows[key];
  };

  // 1. Retract edges from deadbolt_rules (legacy flat absorbed by toMapShape).
  const map = deadboltRules.toMapShape(c.deadbolt_rules, locks).rules || {};
  for (const [lockId, entry] of Object.entries(map)) {
    if (!isSafeKey(lockId) || !isPlainObject(entry)) continue;
    const door = typeof entry.trigger_door === 'string' ? entry.trigger_door.trim() : '';
    // A cleared trigger ('') or a lock_id-only entry means manual-only today:
    // no edge, exactly as the lock is inert for retract right now.
    if (!door) continue;
    flowFor(door, entry.trigger_door_id || null).retract.push({
      lock_id: lockId,
      after_unlock: 'lock_default', // CRITICAL migration default: app schedules nothing
      require_result: entry.require_result || 'ACCESS',
      mirror_unlock: !!entry.mirror_unlock,
      relock_cooldown_seconds: entry.relock_cooldown_seconds == null ? 10 : entry.relock_cooldown_seconds,
    });
  }

  // 2. Cascade rules folded under the same door key. More than one cascade
  //    rule on ONE door (rare, allowed today) unions the unlock lists and
  //    takes the smallest debounce; the caller logs that nuance.
  const rules = (isPlainObject(c.cascade_rules) && Array.isArray(c.cascade_rules.rules))
    ? c.cascade_rules.rules : [];
  for (const rule of rules) {
    if (!isPlainObject(rule)) continue;
    const door = typeof rule.trigger_door === 'string' ? rule.trigger_door.trim() : '';
    if (!door) continue;
    const unlock = Array.isArray(rule.unlock) ? rule.unlock.filter((d) => typeof d === 'string' && d) : [];
    const debounce = rule.debounce_seconds == null ? 8 : rule.debounce_seconds;
    const flow = flowFor(door, rule.trigger_door_id || null);
    if (!flow.cascade) {
      flow.cascade = { unlock: [...unlock], debounce_seconds: debounce };
    } else {
      for (const d of unlock) if (!flow.cascade.unlock.includes(d)) flow.cascade.unlock.push(d);
      flow.cascade.debounce_seconds = Math.min(flow.cascade.debounce_seconds, debounce);
      flow.cascade.merged = true; // signal for the migration log
    }
  }

  return { changed: true, flows };
}

/** Unique lock ids referenced by any retract edge. Order: first appearance. */
function automatedLockIdsFromFlows(flows) {
  const ids = [];
  for (const [door, flow] of Object.entries(flows || {})) {
    if (!isSafeKey(door) || !isPlainObject(flow)) continue;
    for (const edge of (Array.isArray(flow.retract) ? flow.retract : [])) {
      if (edge && edge.lock_id && !ids.includes(edge.lock_id)) ids.push(edge.lock_id);
    }
  }
  return ids;
}

/**
 * Reverse index: every edge pointing at lockId, annotated with its door.
 * Returns [{trigger_door, trigger_door_id, after_unlock, relock_seconds,
 *           require_result, mirror_unlock, relock_cooldown_seconds}, ...]
 */
function edgesForLock(flows, lockId) {
  const out = [];
  if (!lockId) return out;
  for (const [door, flow] of Object.entries(flows || {})) {
    if (!isSafeKey(door) || !isPlainObject(flow)) continue;
    for (const edge of (Array.isArray(flow.retract) ? flow.retract : [])) {
      if (!edge || edge.lock_id !== lockId) continue;
      out.push({
        trigger_door: door,
        trigger_door_id: flow.door_id || null,
        after_unlock: AFTER_UNLOCK_MODES.includes(edge.after_unlock) ? edge.after_unlock : 'lock_default',
        relock_seconds: edge.relock_seconds == null ? null : edge.relock_seconds,
        require_result: edge.require_result || 'ACCESS',
        mirror_unlock: !!edge.mirror_unlock,
        relock_cooldown_seconds: edge.relock_cooldown_seconds == null ? 10 : edge.relock_cooldown_seconds,
      });
    }
  }
  return out;
}

/**
 * Cascade rules in the EXACT shape the existing cascade controller consumes
 * ({trigger_door, trigger_door_id, unlock, debounce_seconds}), so that code
 * path stays unchanged and lock-command-free.
 */
function cascadeRulesFromFlows(flows) {
  const rules = [];
  for (const [door, flow] of Object.entries(flows || {})) {
    if (!isSafeKey(door) || !isPlainObject(flow)) continue;
    const c = flow.cascade;
    if (!isPlainObject(c) || !Array.isArray(c.unlock) || !c.unlock.length) continue;
    rules.push({
      trigger_door: door,
      trigger_door_id: flow.door_id || null,
      unlock: [...c.unlock],
      debounce_seconds: c.debounce_seconds == null ? 8 : c.debounce_seconds,
    });
  }
  return rules;
}

/**
 * The doors that gate keypad access for a lock: every door with a retract
 * edge to it. Returns [{name, id}] (id null until backfilled). Empty array
 * means the lock is UNGATED (no trigger doors -> serves everyone), same as
 * a missing trigger_door today.
 */
function gatingDoorsForLock(flows, lockId) {
  return edgesForLock(flows, lockId).map((e) => ({ name: e.trigger_door, id: e.trigger_door_id }));
}

/**
 * Backfill door ids on flows from the live door registry (name -> id), and
 * refresh a stale display name when the stored id survives a rename.
 * MUTATES flows in place; returns true when anything changed. Mirrors the
 * backfillTriggerDoorIds contract used for the legacy shapes.
 *
 * A rename is applied by RE-KEYING the flow under the new door name (the
 * key is display-oriented; the id is the identity).
 */
function backfillFlowDoorIds(flows, doorsByName, doorsById) {
  if (!isPlainObject(flows)) return false;
  const byName = doorsByName instanceof Map ? doorsByName : new Map(Object.entries(doorsByName || {}));
  const byId = doorsById instanceof Map ? doorsById : new Map(Object.entries(doorsById || {}));
  // Case-insensitive name lookup (door keys are operator-visible strings).
  const byNorm = new Map();
  for (const [name, id] of byName) byNorm.set(normName(name), { name, id: String(id) });
  let changed = false;

  for (const key of Object.keys(flows)) {
    if (!isSafeKey(key)) continue;
    const flow = flows[key];
    if (!isPlainObject(flow)) continue;
    if (!flow.door_id) {
      const hit = byNorm.get(normName(key));
      if (hit) { flow.door_id = hit.id; changed = true; }
    } else if (byId.has(String(flow.door_id))) {
      const liveName = byId.get(String(flow.door_id));
      if (liveName && normName(liveName) !== normName(key)) {
        // Renamed in UniFi: move the flow under the new display name.
        if (!flows[liveName]) {
          flows[liveName] = flow;
          delete flows[key];
          changed = true;
        }
      }
    }
    // Cascade unlock targets: keep names for display, backfill parallel ids.
    const c = flow && flow.cascade;
    if (isPlainObject(c) && Array.isArray(c.unlock)) {
      const ids = Array.isArray(c.unlock_ids) ? c.unlock_ids : new Array(c.unlock.length).fill(null);
      let touched = !Array.isArray(c.unlock_ids);
      for (let i = 0; i < c.unlock.length; i++) {
        if (!ids[i]) {
          const hit = byNorm.get(normName(c.unlock[i]));
          if (hit) { ids[i] = hit.id; touched = true; }
        } else if (byId.has(String(ids[i]))) {
          const liveName = byId.get(String(ids[i]));
          if (liveName && normName(liveName) !== normName(c.unlock[i])) {
            c.unlock[i] = liveName; // refresh display name after a rename
            touched = true;
          }
        }
      }
      if (touched) { c.unlock_ids = ids; changed = true; }
    }
  }
  return changed;
}

/**
 * Validate a door_flows payload (for PUT /api/door-flows and PUT /api/config).
 * Returns an array of error strings (empty = valid). Structural only; door
 * and lock EXISTENCE is the caller's concern (a flow may reference a door
 * that is temporarily undiscovered).
 */
function validateFlows(flows) {
  const errors = [];
  if (!isPlainObject(flows)) return ['door_flows must be an object keyed by door name'];
  for (const [door, flow] of Object.entries(flows)) {
    if (!isSafeKey(door)) { errors.push(`door key "${door}" is not allowed`); continue; }
    if (!door.trim()) { errors.push('door keys must be non-empty names'); continue; }
    if (!isPlainObject(flow)) { errors.push(`flow for "${door}" must be an object`); continue; }
    if (flow.door_id != null && typeof flow.door_id !== 'string') {
      errors.push(`"${door}".door_id must be a string`);
    }
    if (flow.retract != null) {
      if (!Array.isArray(flow.retract)) errors.push(`"${door}".retract must be an array`);
      else {
        for (const edge of flow.retract) {
          if (!isPlainObject(edge) || typeof edge.lock_id !== 'string' || !edge.lock_id) {
            errors.push(`"${door}" has a retract edge without a lock_id`); continue;
          }
          if (edge.after_unlock != null && !AFTER_UNLOCK_MODES.includes(edge.after_unlock)) {
            errors.push(`"${door}"/"${edge.lock_id}": after_unlock must be one of ${AFTER_UNLOCK_MODES.join(', ')}`);
          }
          if (edge.after_unlock === 'relock_after'
              && !(Number.isFinite(edge.relock_seconds) && edge.relock_seconds > 0)) {
            errors.push(`"${door}"/"${edge.lock_id}": relock_after needs relock_seconds > 0`);
          }
          if (edge.relock_cooldown_seconds != null && !(Number.isFinite(edge.relock_cooldown_seconds) && edge.relock_cooldown_seconds >= 0)) {
            errors.push(`"${door}"/"${edge.lock_id}": relock_cooldown_seconds must be a number >= 0`);
          }
          if (edge.require_result != null && typeof edge.require_result !== 'string') {
            errors.push(`"${door}"/"${edge.lock_id}": require_result must be a string`);
          }
        }
        const seen = new Set();
        for (const edge of flow.retract) {
          if (isPlainObject(edge) && edge.lock_id) {
            if (seen.has(edge.lock_id)) errors.push(`"${door}" retracts "${edge.lock_id}" more than once`);
            seen.add(edge.lock_id);
          }
        }
      }
    }
    if (flow.cascade != null) {
      const c = flow.cascade;
      if (!isPlainObject(c)) errors.push(`"${door}".cascade must be an object`);
      else {
        if (!Array.isArray(c.unlock) || c.unlock.some((d) => typeof d !== 'string' || !d)) {
          errors.push(`"${door}".cascade.unlock must be an array of door names`);
        }
        if (c.debounce_seconds != null && !(Number.isFinite(c.debounce_seconds) && c.debounce_seconds >= 0)) {
          errors.push(`"${door}".cascade.debounce_seconds must be a number >= 0`);
        }
      }
    }
  }
  return errors;
}

/**
 * Derived read-only legacy projection ({deadbolt_rules, cascade_rules}) for
 * one transition release: external readers of GET /api/config keep working.
 * Never persisted. A lock triggered by SEVERAL doors projects its FIRST edge
 * only (the legacy shape cannot express more).
 */
function legacyProjection(flows) {
  const deadbolt_rules = {};
  for (const lockId of automatedLockIdsFromFlows(flows)) {
    const edges = edgesForLock(flows, lockId);
    const e = edges[0];
    deadbolt_rules[lockId] = {
      trigger_door: e.trigger_door,
      trigger_door_id: e.trigger_door_id || undefined,
      require_result: e.require_result,
      mirror_unlock: e.mirror_unlock,
      relock_cooldown_seconds: e.relock_cooldown_seconds,
    };
  }
  return { deadbolt_rules, cascade_rules: { rules: cascadeRulesFromFlows(flows) } };
}

module.exports = {
  AFTER_UNLOCK_MODES,
  normName,
  migrateToFlows,
  automatedLockIdsFromFlows,
  edgesForLock,
  cascadeRulesFromFlows,
  gatingDoorsForLock,
  backfillFlowDoorIds,
  validateFlows,
  legacyProjection,
};
