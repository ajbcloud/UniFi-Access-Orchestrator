'use strict';

/**
 * door_flows: the door-centric automation shape (pure, unit-testable).
 *
 * Product model: "everything starts at the door." Configuring a door answers
 * one question, when something happens here, what should happen? Each door
 * holds a list of TRIGGERS. A trigger has a type (entry or doorbell), a scope
 * (who it applies to) and a set of actions:
 *   retract: real Z-Wave lock commands to one or more deadbolts, each edge
 *            carrying its OWN after-unlock behavior and advanced fields
 *            (one door may make a deadbolt behave differently than another);
 *   unlock:  momentary UniFi unlocks of OTHER doors (never a lock command),
 *            with a debounce and an optional delay.
 *
 * Canonical persisted shape (the sole automation source of truth on disk):
 *   door_flows: {
 *     "<door name>": {
 *       door_id: "abc123" | null,        // rename-proof id, backfilled lazily
 *       triggers: [
 *         {
 *           type: "entry" | "doorbell",
 *           scope: null                   // everyone, incl unresolved users
 *                | { any_group: true }    // any RESOLVED group (skips unresolved)
 *                | { groups: ["Staff"] }, // only these resolved groups
 *           actions: {
 *             unlock: [ { doors: ["Interior Door"], door_ids: [id|null,...],
 *                         debounce_seconds: 8, delay_seconds: 0 }, ... ],
 *                      // ARRAY of unlock actions, each with its OWN delay +
 *                      // debounce. Legacy configs stored a single object (or
 *                      // null); readers accept both and migration normalizes
 *                      // to the array on load.
 *             retract: [ {
 *               lock_id: "front_deadbolt",
 *               after_unlock: 'stay_unlocked' | 'relock_after' | 'lock_default',
 *               relock_seconds: 30,        // only meaningful for relock_after
 *               require_result: 'ACCESS',
 *               mirror_unlock: false,
 *               relock_cooldown_seconds: 10,
 *             } ]
 *           },
 *           doorbell: { reason_code: 107, viewer_to_group: {...} } // doorbell only
 *         }
 *       ]
 *     }, ...
 *   }
 *
 * Door KEYS remain display names (readable configs, same matching contract as
 * the old trigger_door); each flow carries door_id so controller matching and
 * access gating survive a UniFi rename.
 *
 * BACK-COMPAT: the pure helpers below read BOTH the current trigger shape and
 * the earlier flat shape ({ retract, cascade } directly on the door). A flat
 * flow normalizes to a single everyone entry trigger, so a v10 config keeps
 * behaving identically until it is migrated forward on load.
 *
 * MIGRATION INVARIANT (the #1 correctness rule): the shape migration (steps 1
 * to 4) must behave IDENTICALLY to before. The single deliberate behavior
 * change is decision 2 (after-unlock conversion + hardware handoff), which
 * runs only after the shape has been converted.
 */

const deadboltRules = require('./deadbolt-rules');

// Modes we still READ (lock_default lives only in un-migrated configs; the UI
// writes only the two deterministic modes).
const AFTER_UNLOCK_MODES = Object.freeze(['lock_default', 'stay_unlocked', 'relock_after']);
const AFTER_UNLOCK_WRITE_MODES = Object.freeze(['stay_unlocked', 'relock_after']);
const TRIGGER_TYPES = Object.freeze(['entry', 'doorbell']);
const DEFAULT_DOORBELL_REASON_CODE = 107;
const DEFAULT_LOCK_DEFAULT_RELOCK_SECONDS = 30; // catalog says "about 30s"

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeKey(k) { return !UNSAFE_KEYS.has(k); }
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** Normalized (case-insensitive, trimmed) name comparison key. */
function normName(name) {
  return String(name == null ? '' : name).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Shape accessors (read both the trigger shape and the earlier flat shape)
// ---------------------------------------------------------------------------

/** Turn a flat flow's cascade into an unlock action, or null. */
function cascadeToUnlockAction(cascade) {
  if (!isPlainObject(cascade) || !Array.isArray(cascade.unlock) || !cascade.unlock.length) return null;
  const action = {
    doors: cascade.unlock.filter((d) => typeof d === 'string' && d),
    debounce_seconds: cascade.debounce_seconds == null ? 8 : cascade.debounce_seconds,
    delay_seconds: 0,
  };
  if (Array.isArray(cascade.unlock_ids)) action.door_ids = [...cascade.unlock_ids];
  return action.doors.length ? action : null;
}

/**
 * Every trigger on a flow, as an array. A trigger-shaped flow returns its
 * triggers verbatim; a flat flow synthesizes one everyone entry trigger from
 * its retract + cascade so old configs read the same.
 */
function triggersOf(flow) {
  if (!isPlainObject(flow)) return [];
  if (Array.isArray(flow.triggers)) return flow.triggers.filter(isPlainObject);
  const retract = Array.isArray(flow.retract) ? flow.retract : [];
  const unlock = cascadeToUnlockAction(flow.cascade);
  if (!retract.length && !unlock) return [];
  return [{ type: 'entry', scope: null, actions: { unlock: unlock ? [unlock] : [], retract } }];
}

/** The retract edges of a trigger (defensive). */
function retractOf(trigger) {
  const r = trigger && trigger.actions && trigger.actions.retract;
  return Array.isArray(r) ? r : [];
}

/** One unlock action, validated: needs a non-empty doors list. */
function validUnlockAction(u) {
  return isPlainObject(u) && Array.isArray(u.doors) && u.doors.length ? u : null;
}

/**
 * ALL unlock actions of a trigger, as an array. The canonical shape stores an
 * array; a legacy single object (or null) reads as a 0/1-element array so old
 * configs and old PUT payloads keep working.
 */
function unlockActionsOf(trigger) {
  const u = trigger && trigger.actions && trigger.actions.unlock;
  if (Array.isArray(u)) return u.map(validUnlockAction).filter(Boolean);
  const one = validUnlockAction(u);
  return one ? [one] : [];
}

/** The FIRST unlock action of a trigger, or null (legacy readers only). */
function unlockOf(trigger) {
  return unlockActionsOf(trigger)[0] || null;
}

/** Canonicalize a scope value to null | {any_group:true} | {groups:[...]}. */
function normalizeScope(scope) {
  if (!isPlainObject(scope)) return null;
  if (scope.any_group === true) return { any_group: true };
  if (Array.isArray(scope.groups)) {
    const groups = scope.groups.filter((g) => typeof g === 'string' && g.trim());
    return groups.length ? { groups } : null;
  }
  return null;
}

/**
 * Does a trigger scope match a resolved group?
 *   scope null            -> everyone, including an unresolved user
 *   scope { any_group }    -> any resolved group; an unresolved user is skipped
 *   scope { groups: [...] }-> only these groups (case-insensitive)
 * @param {string|null} resolvedGroup null means the user resolved to no group.
 */
function scopeMatches(scope, resolvedGroup) {
  const s = normalizeScope(scope);
  if (s == null) return true;
  if (s.any_group === true) return !!resolvedGroup;
  if (!resolvedGroup) return false;
  const g = normName(resolvedGroup);
  return s.groups.some((x) => normName(x) === g);
}

// ---------------------------------------------------------------------------
// migrateToFlows: legacy {deadbolt_rules, cascade_rules} -> flat door_flows
// (kept for back-compat; the trigger migration builds on top of it)
// ---------------------------------------------------------------------------

/**
 * Migrate {deadbolt_rules, cascade_rules} to the flat door_flows shape.
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

// ---------------------------------------------------------------------------
// migrateToTriggers: the door-flow spine migration (flat + legacy rules ->
// the trigger shape). Pure, idempotent, flows-win. See section 5 of the spec.
// ---------------------------------------------------------------------------

/** A normalized rule list ({group, trigger, unlock, delay}) from unlock_rules
 *  / doorbell_rules, absorbing the legacy trigger_location + group_actions
 *  alternate shape exactly as the rules engine did. IMPORTANT: the rules engine
 *  applied trigger_location ONLY to the group_actions shape, never to an
 *  array-shaped rule. An array rule with no `trigger` never matched (it stays a
 *  dead rule), so we must NOT graft trigger_location onto it here or migration
 *  would resurrect an unlock that never fired. */
function normalizeRuleList(rulesConfig) {
  if (!isPlainObject(rulesConfig)) return [];
  if (Array.isArray(rulesConfig.rules)) {
    return rulesConfig.rules.filter(isPlainObject).map((r) => ({
      group: typeof r.group === 'string' ? r.group : null,
      trigger: typeof r.trigger === 'string' ? r.trigger : '',
      unlock: Array.isArray(r.unlock) ? r.unlock.filter((d) => typeof d === 'string' && d) : [],
      delay: Number.isFinite(r.delay) ? r.delay : 0,
    }));
  }
  const fallbackTrigger = typeof rulesConfig.trigger_location === 'string' ? rulesConfig.trigger_location : '';
  const groupActions = isPlainObject(rulesConfig.group_actions) ? rulesConfig.group_actions : {};
  const out = [];
  for (const [group, action] of Object.entries(groupActions)) {
    if (!isSafeKey(group)) continue;
    const doors = (isPlainObject(action) && Array.isArray(action.unlock))
      ? action.unlock.filter((d) => typeof d === 'string' && d) : [];
    if (doors.length) out.push({ group, trigger: fallbackTrigger, unlock: doors, delay: Number.isFinite(action && action.delay) ? action.delay : 0 });
  }
  return out;
}

/** The doors a default_action fallback should attach to. The old default_action
 *  fired at ANY door for any resolved group with no matching rule; a
 *  door-centric model cannot express "any door", so we approximate it with
 *  every door the config knows about (rule trigger doors, trigger_location, and
 *  every already-configured flow door). A default_action still cannot fire at a
 *  door with no other configuration, a documented limitation. */
function candidateTriggerDoors(rulesConfig, normalizedRules, extraDoors) {
  const set = [];
  const add = (d) => { const t = String(d || '').trim(); if (t && isSafeKey(t) && !set.some((x) => normName(x) === normName(t))) set.push(t); };
  for (const r of normalizedRules) add(r.trigger);
  for (const d of (extraDoors || [])) add(d);
  if (rulesConfig && typeof rulesConfig.trigger_location === 'string') add(rulesConfig.trigger_location);
  return set;
}

function ensureFlow(flows, door) {
  const key = String(door).trim();
  if (!isSafeKey(key)) return null; // never let a rule name a prototype-polluting door
  if (!Object.prototype.hasOwnProperty.call(flows, key)) flows[key] = { door_id: null, triggers: [] };
  if (!Array.isArray(flows[key].triggers)) flows[key].triggers = [];
  return flows[key];
}

/** Add (or merge into) an unlock-bearing trigger. Two rules that share a door,
 *  type and scope union their unlock lists under a single delay (the largest),
 *  mirroring the rules engine's merge + single-delay-for-the-set behavior. */
function addUnlockTrigger(flow, type, scope, doors, delay, doorbell, debounceSeconds) {
  const wantScope = normalizeScope(scope);
  const debounce = debounceSeconds == null ? 0 : debounceSeconds;
  const match = flow.triggers.find((t) => t.type === type
    && sameScope(normalizeScope(t.scope), wantScope)
    && sameDoorbell(t.doorbell || null, doorbell || null)
    && unlockActionsOf(t).length);
  if (match) {
    const u = unlockActionsOf(match)[0];
    for (const d of doors) if (!u.doors.some((x) => normName(x) === normName(d))) u.doors.push(d);
    u.delay_seconds = Math.max(u.delay_seconds || 0, delay || 0);
    return;
  }
  const trigger = {
    type,
    scope: wantScope,
    actions: {
      unlock: [{ doors: [...doors], debounce_seconds: debounce, delay_seconds: delay || 0 }],
      retract: [],
    },
  };
  if (doorbell) trigger.doorbell = doorbell;
  flow.triggers.push(trigger);
}

function sameScope(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a.any_group || b.any_group) return !!a.any_group === !!b.any_group;
  const ga = (a.groups || []).map(normName).sort();
  const gb = (b.groups || []).map(normName).sort();
  return ga.length === gb.length && ga.every((x, i) => x === gb[i]);
}

function sameDoorbell(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return (a.reason_code || DEFAULT_DOORBELL_REASON_CODE) === (b.reason_code || DEFAULT_DOORBELL_REASON_CODE);
}

/** Convert a flat flow (or an already-trigger flow) to the trigger shape. Deep
 *  copies so the migration is PURE: convertLockDefaults (and callers) must never
 *  mutate the input config's trigger/edge objects. */
function toTriggerFlow(flow, state) {
  if (!isPlainObject(flow)) return { door_id: null, triggers: [] };
  if (Array.isArray(flow.triggers)) {
    const triggers = flow.triggers.filter(isPlainObject).map((t) => JSON.parse(JSON.stringify(t)));
    // Normalize a legacy single unlock object (or null) to the array shape.
    for (const t of triggers) {
      if (!isPlainObject(t.actions)) continue;
      const u = t.actions.unlock;
      if (Array.isArray(u)) continue;
      t.actions.unlock = isPlainObject(u) ? [u] : [];
      if (state) state.changed = true;
    }
    return { door_id: flow.door_id || null, triggers };
  }
  if (state) state.changed = true; // a flat flow was upgraded
  const retract = Array.isArray(flow.retract) ? flow.retract.map((e) => ({ ...e })) : [];
  const unlock = cascadeToUnlockAction(flow.cascade);
  const triggers = [];
  if (retract.length || unlock) {
    triggers.push({ type: 'entry', scope: null, actions: { unlock: unlock ? [unlock] : [], retract } });
  }
  return { door_id: flow.door_id || null, triggers };
}

/** Step 5 (shape half): convert lock_default edges to a deterministic mode
 *  using the lock's saved auto_relock state. Returns conversion log entries. */
function convertLockDefaults(flows, locks, logs) {
  const lockMap = isPlainObject(locks) ? locks : {};
  let changed = false;
  for (const [door, flow] of Object.entries(flows)) {
    if (!isSafeKey(door) || !isPlainObject(flow)) continue;
    for (const trig of (Array.isArray(flow.triggers) ? flow.triggers : [])) {
      for (const edge of retractOf(trig)) {
        if (!edge || edge.after_unlock !== 'lock_default') continue;
        const lock = lockMap[edge.lock_id] || {};
        if (lock.auto_relock === true) {
          edge.after_unlock = 'relock_after';
          const secs = Number.isFinite(lock.auto_relock_seconds) && lock.auto_relock_seconds > 0
            ? lock.auto_relock_seconds : DEFAULT_LOCK_DEFAULT_RELOCK_SECONDS;
          edge.relock_seconds = secs;
          if (logs) logs.push(`after-unlock: "${edge.lock_id}" at "${door}" converted lock_default -> relock_after ${secs}s (hardware auto-relock was on)`);
        } else {
          edge.after_unlock = 'stay_unlocked';
          if (logs) logs.push(`after-unlock: "${edge.lock_id}" at "${door}" converted lock_default -> stay_unlocked (app owns relock now)`);
        }
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * The door-flow spine migration. Folds {deadbolt_rules, cascade_rules,
 * unlock_rules, doorbell_rules} and a flat door_flows into the trigger shape.
 * Returns { changed, flows, logs }. Idempotent: an already-migrated config
 * (trigger-shaped door_flows, no legacy rule keys, no lock_default edges)
 * passes through with changed=false.
 */
function migrateToTriggers(cfg, locks) {
  const c = cfg || {};
  const logs = [];
  const state = { changed: false };

  // Base: flat door_flows from {deadbolt_rules, cascade_rules} (or an existing
  // door_flows passed through).
  const base = migrateToFlows(c, locks).flows || {};

  // "Flows win over stale legacy keys": once door_flows is the trigger-shaped
  // truth, unlock_rules / doorbell_rules that survive on disk (a restored
  // pre-spine backup, a hand edit) are stale and ignored. They are folded only
  // on the FIRST migration, when door_flows is still flat or absent. A PUT that
  // deliberately writes legacy rules folds them explicitly (see index.js).
  const flowsAreAuthoritative = isPlainObject(c.door_flows)
    && Object.values(c.door_flows).some((f) => isPlainObject(f) && Array.isArray(f.triggers));
  const hadLegacyRules = !flowsAreAuthoritative
    && (isPlainObject(c.unlock_rules) || isPlainObject(c.doorbell_rules));

  const flows = {};
  for (const [door, flow] of Object.entries(base)) {
    if (!isSafeKey(door) || !isPlainObject(flow)) continue;
    flows[String(door).trim()] = toTriggerFlow(flow, state);
  }

  // Fold unlock_rules (steps 2 + 3).
  if (!flowsAreAuthoritative && isPlainObject(c.unlock_rules)) {
    const rules = normalizeRuleList(c.unlock_rules);
    for (const r of rules) {
      const door = String(r.trigger || '').trim();
      if (!r.group || !door || !r.unlock.length) continue;
      const flow = ensureFlow(flows, door);
      if (!flow) continue;
      addUnlockTrigger(flow, 'entry', { groups: [r.group] }, r.unlock, r.delay, null, 0);
      state.changed = true;
    }
    const da = c.unlock_rules.default_action;
    const daDoors = isPlainObject(da) && Array.isArray(da.unlock) ? da.unlock.filter((d) => typeof d === 'string' && d) : [];
    if (daDoors.length) {
      const doors = candidateTriggerDoors(c.unlock_rules, rules, Object.keys(flows)).map((d) => ensureFlow(flows, d)).filter(Boolean);
      if (doors.length) {
        for (const flow of doors) addUnlockTrigger(flow, 'entry', { any_group: true }, daDoors, 0, null, 0);
        state.changed = true;
        logs.push(`unlock_rules.default_action migrated to an "any resolved group" trigger on ${doors.length} door(s)`);
      } else {
        logs.push('unlock_rules.default_action has no trigger door to attach to; skipped (no rules and no trigger_location)');
      }
    }
  }

  // Fold doorbell_rules (step 4).
  if (!flowsAreAuthoritative && isPlainObject(c.doorbell_rules)) {
    const reason = Number.isFinite(c.doorbell_rules.trigger_reason_code) ? c.doorbell_rules.trigger_reason_code : DEFAULT_DOORBELL_REASON_CODE;
    const viewer = isPlainObject(c.doorbell_rules.viewer_to_group) ? { ...c.doorbell_rules.viewer_to_group } : {};
    const meta = () => ({ reason_code: reason, viewer_to_group: { ...viewer } });
    const rules = normalizeRuleList(c.doorbell_rules);
    for (const r of rules) {
      const door = String(r.trigger || '').trim();
      if (!r.group || !door || !r.unlock.length) continue;
      const flow = ensureFlow(flows, door);
      if (!flow) continue;
      addUnlockTrigger(flow, 'doorbell', { groups: [r.group] }, r.unlock, r.delay, meta(), 0);
      state.changed = true;
    }
    const da = c.doorbell_rules.default_action;
    const daDoors = isPlainObject(da) && Array.isArray(da.unlock) ? da.unlock.filter((d) => typeof d === 'string' && d) : [];
    if (daDoors.length) {
      const doors = candidateTriggerDoors(c.doorbell_rules, rules, Object.keys(flows)).map((d) => ensureFlow(flows, d)).filter(Boolean);
      if (doors.length) {
        for (const flow of doors) addUnlockTrigger(flow, 'doorbell', { any_group: true }, daDoors, 0, meta(), 0);
        state.changed = true;
        logs.push(`doorbell_rules.default_action migrated to an "any resolved group" doorbell trigger on ${doors.length} door(s)`);
      } else {
        logs.push('doorbell_rules.default_action has no trigger door to attach to; skipped');
      }
    }
  }

  // Step 5 shape half: convert lock_default edges deterministically.
  if (convertLockDefaults(flows, locks, logs)) state.changed = true;

  // Drop doors that ended up with no triggers at all.
  for (const key of Object.keys(flows)) {
    if (!flows[key].triggers.length) delete flows[key];
  }

  const changed = state.changed || hadLegacyRules
    || isPlainObject(c.deadbolt_rules) || isPlainObject(c.cascade_rules);
  return { changed, flows, logs };
}

// ---------------------------------------------------------------------------
// Reverse-index helpers (walk the trigger shape; tolerate the flat shape)
// ---------------------------------------------------------------------------

/** Unique lock ids referenced by any retract edge. Order: first appearance. */
function automatedLockIdsFromFlows(flows) {
  const ids = [];
  for (const [door, flow] of Object.entries(flows || {})) {
    if (!isSafeKey(door) || !isPlainObject(flow)) continue;
    for (const trig of triggersOf(flow)) {
      for (const edge of retractOf(trig)) {
        if (edge && edge.lock_id && !ids.includes(edge.lock_id)) ids.push(edge.lock_id);
      }
    }
  }
  return ids;
}

/**
 * Reverse index: every retract edge pointing at lockId, annotated with its
 * door and its owning trigger's type/scope/doorbell so the controller can gate
 * by who and by which event fired.
 */
function edgesForLock(flows, lockId) {
  const out = [];
  if (!lockId) return out;
  for (const [door, flow] of Object.entries(flows || {})) {
    if (!isSafeKey(door) || !isPlainObject(flow)) continue;
    for (const trig of triggersOf(flow)) {
      const type = TRIGGER_TYPES.includes(trig.type) ? trig.type : 'entry';
      const scope = normalizeScope(trig.scope);
      const doorbell = isPlainObject(trig.doorbell) ? trig.doorbell : null;
      for (const edge of retractOf(trig)) {
        if (!edge || edge.lock_id !== lockId) continue;
        out.push({
          trigger_door: door,
          trigger_door_id: flow.door_id || null,
          type,
          scope,
          doorbell,
          after_unlock: AFTER_UNLOCK_MODES.includes(edge.after_unlock) ? edge.after_unlock : 'lock_default',
          relock_seconds: edge.relock_seconds == null ? null : edge.relock_seconds,
          require_result: edge.require_result || 'ACCESS',
          mirror_unlock: !!edge.mirror_unlock,
          relock_cooldown_seconds: edge.relock_cooldown_seconds == null ? 10 : edge.relock_cooldown_seconds,
        });
      }
    }
  }
  return out;
}

/**
 * Legacy cascade rules ({trigger_door, trigger_door_id, unlock, debounce_
 * seconds}) from the everyone entry triggers only (the old cascade). Used by
 * legacyProjection so external readers keep seeing the old shape.
 */
function cascadeRulesFromFlows(flows) {
  const rules = [];
  for (const [door, flow] of Object.entries(flows || {})) {
    if (!isSafeKey(door) || !isPlainObject(flow)) continue;
    for (const trig of triggersOf(flow)) {
      if ((TRIGGER_TYPES.includes(trig.type) ? trig.type : 'entry') !== 'entry') continue;
      if (normalizeScope(trig.scope) != null) continue; // group-scoped unlocks are unlock_rules
      for (const u of unlockActionsOf(trig)) {
        rules.push({
          trigger_door: door,
          trigger_door_id: flow.door_id || null,
          unlock: [...u.doors],
          debounce_seconds: u.debounce_seconds == null ? 8 : u.debounce_seconds,
        });
      }
    }
  }
  return rules;
}

/**
 * Every unlock-bearing trigger, as a scoped rule the controller consumes:
 * {trigger_door, trigger_door_id, type, scope, unlock, unlock_ids,
 *  debounce_seconds, delay_seconds, doorbell}. Covers entry cascades, group
 * scoped unlocks and doorbell unlocks in one list.
 */
function unlockRulesFromFlows(flows) {
  const rules = [];
  for (const [door, flow] of Object.entries(flows || {})) {
    if (!isSafeKey(door) || !isPlainObject(flow)) continue;
    for (const trig of triggersOf(flow)) {
      for (const u of unlockActionsOf(trig)) {
        rules.push({
          trigger_door: door,
          trigger_door_id: flow.door_id || null,
          type: TRIGGER_TYPES.includes(trig.type) ? trig.type : 'entry',
          scope: normalizeScope(trig.scope),
          unlock: [...u.doors],
          unlock_ids: Array.isArray(u.door_ids) ? [...u.door_ids] : undefined,
          debounce_seconds: u.debounce_seconds == null ? 8 : u.debounce_seconds,
          delay_seconds: u.delay_seconds == null ? 0 : u.delay_seconds,
          doorbell: isPlainObject(trig.doorbell) ? trig.doorbell : null,
        });
      }
    }
  }
  return rules;
}

/**
 * The doors that gate keypad access for a lock: every door with a retract edge
 * to it. Returns [{name, id}] (id null until backfilled). Empty array means
 * the lock is UNGATED (no trigger doors -> serves everyone).
 */
function gatingDoorsForLock(flows, lockId) {
  const seen = new Set();
  const out = [];
  for (const e of edgesForLock(flows, lockId)) {
    const key = e.trigger_door_id ? `id:${e.trigger_door_id}` : `name:${normName(e.trigger_door)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: e.trigger_door, id: e.trigger_door_id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// backfillFlowDoorIds: rename-proof identity (walks both shapes)
// ---------------------------------------------------------------------------

/**
 * Backfill door ids on flows from the live door registry (name -> id), and
 * refresh a stale display name when the stored id survives a rename. MUTATES
 * flows in place; returns true when anything changed.
 */
function backfillFlowDoorIds(flows, doorsByName, doorsById) {
  if (!isPlainObject(flows)) return false;
  const byName = doorsByName instanceof Map ? doorsByName : new Map(Object.entries(doorsByName || {}));
  const byId = doorsById instanceof Map ? doorsById : new Map(Object.entries(doorsById || {}));
  const byNorm = new Map();
  for (const [name, id] of byName) byNorm.set(normName(name), { name, id: String(id) });
  let changed = false;

  const backfillUnlockTargets = (action) => {
    if (!isPlainObject(action) || !Array.isArray(action.doors)) return;
    const ids = Array.isArray(action.door_ids) ? action.door_ids : new Array(action.doors.length).fill(null);
    let touched = !Array.isArray(action.door_ids);
    for (let i = 0; i < action.doors.length; i++) {
      if (!ids[i]) {
        const hit = byNorm.get(normName(action.doors[i]));
        if (hit) { ids[i] = hit.id; touched = true; }
      } else if (byId.has(String(ids[i]))) {
        const liveName = byId.get(String(ids[i]));
        if (liveName && normName(liveName) !== normName(action.doors[i])) {
          action.doors[i] = liveName; touched = true;
        }
      }
    }
    if (touched) { action.door_ids = ids; changed = true; }
  };

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
        if (!flows[liveName]) {
          flows[liveName] = flow;
          delete flows[key];
          changed = true;
        }
      }
    }
    // Unlock targets: keep names for display, backfill parallel ids. The flow
    // object reference is stable across a re-key, so operate on it directly.
    // Handles the trigger shape (per trigger) and the flat shape (flow.cascade).
    if (Array.isArray(flow.triggers)) {
      for (const trig of flow.triggers) {
        if (!isPlainObject(trig) || !trig.actions) continue;
        const u = trig.actions.unlock;
        if (Array.isArray(u)) for (const a of u) backfillUnlockTargets(a);
        else backfillUnlockTargets(u);
      }
    } else if (isPlainObject(flow.cascade)) {
      const c = flow.cascade;
      const ids = Array.isArray(c.unlock_ids) ? c.unlock_ids : new Array((c.unlock || []).length).fill(null);
      let touched = !Array.isArray(c.unlock_ids);
      for (let i = 0; i < (c.unlock || []).length; i++) {
        if (!ids[i]) {
          const hit = byNorm.get(normName(c.unlock[i]));
          if (hit) { ids[i] = hit.id; touched = true; }
        } else if (byId.has(String(ids[i]))) {
          const liveName = byId.get(String(ids[i]));
          if (liveName && normName(liveName) !== normName(c.unlock[i])) { c.unlock[i] = liveName; touched = true; }
        }
      }
      if (touched) { c.unlock_ids = ids; changed = true; }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// validateFlows: structural validation for PUT (both shapes)
// ---------------------------------------------------------------------------

function validateRetractEdges(edges, label, errors) {
  if (!Array.isArray(edges)) { errors.push(`${label} retract must be an array`); return; }
  const seen = new Set();
  for (const edge of edges) {
    if (!isPlainObject(edge) || typeof edge.lock_id !== 'string' || !edge.lock_id) {
      errors.push(`${label} has a retract edge without a lock_id`); continue;
    }
    if (edge.after_unlock != null && !AFTER_UNLOCK_MODES.includes(edge.after_unlock)) {
      errors.push(`${label}/"${edge.lock_id}": after_unlock must be one of ${AFTER_UNLOCK_MODES.join(', ')}`);
    }
    if (edge.after_unlock === 'relock_after' && !(Number.isFinite(edge.relock_seconds) && edge.relock_seconds > 0)) {
      errors.push(`${label}/"${edge.lock_id}": relock_after needs relock_seconds > 0`);
    }
    if (edge.relock_cooldown_seconds != null && !(Number.isFinite(edge.relock_cooldown_seconds) && edge.relock_cooldown_seconds >= 0)) {
      errors.push(`${label}/"${edge.lock_id}": relock_cooldown_seconds must be a number >= 0`);
    }
    if (edge.require_result != null && typeof edge.require_result !== 'string') {
      errors.push(`${label}/"${edge.lock_id}": require_result must be a string`);
    }
    if (seen.has(edge.lock_id)) errors.push(`${label} retracts "${edge.lock_id}" more than once`);
    seen.add(edge.lock_id);
  }
}

function validateUnlockAction(unlock, label, errors) {
  if (unlock == null) return;
  if (Array.isArray(unlock)) {
    unlock.forEach((u, i) => validateOneUnlockAction(u, `${label} unlock[${i}]`, errors));
    return;
  }
  validateOneUnlockAction(unlock, `${label} unlock`, errors);
}

function validateOneUnlockAction(unlock, label, errors) {
  if (unlock == null) return;
  if (!isPlainObject(unlock)) { errors.push(`${label} must be an object`); return; }
  if (!Array.isArray(unlock.doors) || unlock.doors.some((d) => typeof d !== 'string' || !d)) {
    errors.push(`${label}.doors must be an array of door names`);
  }
  if (unlock.debounce_seconds != null && !(Number.isFinite(unlock.debounce_seconds) && unlock.debounce_seconds >= 0)) {
    errors.push(`${label}.debounce_seconds must be a number >= 0`);
  }
  if (unlock.delay_seconds != null && !(Number.isFinite(unlock.delay_seconds) && unlock.delay_seconds >= 0)) {
    errors.push(`${label}.delay_seconds must be a number >= 0`);
  }
}

function validateScope(scope, label, errors) {
  if (scope == null) return;
  if (!isPlainObject(scope)) { errors.push(`${label} scope must be null or an object`); return; }
  if (scope.any_group != null && typeof scope.any_group !== 'boolean') {
    errors.push(`${label} scope.any_group must be a boolean`);
  }
  if (scope.groups != null && (!Array.isArray(scope.groups) || scope.groups.some((g) => typeof g !== 'string' || !g))) {
    errors.push(`${label} scope.groups must be an array of group names`);
  }
}

/**
 * Validate a door_flows payload. Returns an array of error strings (empty =
 * valid). Accepts BOTH the trigger shape and the earlier flat shape so an
 * external writer mid-transition is not rejected.
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
    if (Array.isArray(flow.triggers)) {
      flow.triggers.forEach((trig, i) => {
        const label = `"${door}" trigger ${i + 1}`;
        if (!isPlainObject(trig)) { errors.push(`${label} must be an object`); return; }
        if (trig.type != null && !TRIGGER_TYPES.includes(trig.type)) {
          errors.push(`${label} type must be one of ${TRIGGER_TYPES.join(', ')}`);
        }
        validateScope(trig.scope, label, errors);
        if (trig.actions != null && !isPlainObject(trig.actions)) {
          errors.push(`${label} actions must be an object`);
        } else if (isPlainObject(trig.actions)) {
          validateUnlockAction(trig.actions.unlock, label, errors);
          if (trig.actions.retract != null) validateRetractEdges(trig.actions.retract, label, errors);
        }
      });
    } else {
      // Flat legacy shape.
      if (flow.retract != null) validateRetractEdges(flow.retract, `"${door}"`, errors);
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
  }
  return errors;
}

// ---------------------------------------------------------------------------
// legacyProjection: derived, read-only old shapes for GET /api/config
// ---------------------------------------------------------------------------

function unionInto(target, doors) {
  for (const d of doors) if (!target.some((x) => normName(x) === normName(d))) target.push(d);
}

/**
 * Derived read-only projection ({deadbolt_rules, cascade_rules, unlock_rules,
 * doorbell_rules}) for one transition release: external readers of GET
 * /api/config keep working. Never persisted. A lock triggered by SEVERAL doors
 * projects its FIRST edge only (the legacy shape cannot express more).
 */
function legacyProjection(flows) {
  const deadbolt_rules = {};
  for (const lockId of automatedLockIdsFromFlows(flows)) {
    const e = edgesForLock(flows, lockId)[0];
    deadbolt_rules[lockId] = {
      trigger_door: e.trigger_door,
      trigger_door_id: e.trigger_door_id || undefined,
      require_result: e.require_result,
      mirror_unlock: e.mirror_unlock,
      relock_cooldown_seconds: e.relock_cooldown_seconds,
    };
  }

  const unlock_rules = { rules: [], default_action: { unlock: [] } };
  const doorbell_rules = { rules: [], trigger_reason_code: DEFAULT_DOORBELL_REASON_CODE, viewer_to_group: {}, default_action: { unlock: [] } };
  for (const [door, flow] of Object.entries(flows || {})) {
    if (!isSafeKey(door) || !isPlainObject(flow)) continue;
    for (const trig of triggersOf(flow)) {
      const actionsList = unlockActionsOf(trig);
      if (!actionsList.length) continue;
      const type = TRIGGER_TYPES.includes(trig.type) ? trig.type : 'entry';
      const scope = normalizeScope(trig.scope);
      for (const u of actionsList) {
        if (type === 'doorbell') {
          if (isPlainObject(trig.doorbell)) {
            if (Number.isFinite(trig.doorbell.reason_code)) doorbell_rules.trigger_reason_code = trig.doorbell.reason_code;
            if (isPlainObject(trig.doorbell.viewer_to_group)) Object.assign(doorbell_rules.viewer_to_group, trig.doorbell.viewer_to_group);
          }
          if (scope && scope.any_group) unionInto(doorbell_rules.default_action.unlock, u.doors);
          else if (scope && scope.groups) for (const g of scope.groups) doorbell_rules.rules.push({ group: g, trigger: door, unlock: [...u.doors], delay: u.delay_seconds || 0 });
        } else {
          if (scope == null) continue; // everyone entry = cascade, projected below
          if (scope.any_group) unionInto(unlock_rules.default_action.unlock, u.doors);
          else if (scope.groups) for (const g of scope.groups) unlock_rules.rules.push({ group: g, trigger: door, unlock: [...u.doors], delay: u.delay_seconds || 0 });
        }
      }
    }
  }

  return {
    deadbolt_rules,
    cascade_rules: { rules: cascadeRulesFromFlows(flows) },
    unlock_rules,
    doorbell_rules,
  };
}

module.exports = {
  AFTER_UNLOCK_MODES,
  AFTER_UNLOCK_WRITE_MODES,
  TRIGGER_TYPES,
  DEFAULT_DOORBELL_REASON_CODE,
  normName,
  scopeMatches,
  triggersOf,
  unlockActionsOf,
  migrateToFlows,
  migrateToTriggers,
  automatedLockIdsFromFlows,
  edgesForLock,
  cascadeRulesFromFlows,
  unlockRulesFromFlows,
  gatingDoorsForLock,
  backfillFlowDoorIds,
  validateFlows,
  legacyProjection,
};
