'use strict';

/**
 * deadbolt_rules shape helpers (pure, unit-testable, no dependencies).
 *
 * Two shapes exist in the wild:
 *   LEGACY FLAT (v8.x single-lock):
 *     { "lock_id": "front_deadbolt", "trigger_door": "Front Door",
 *       "require_result": "ACCESS", "mirror_unlock": false,
 *       "relock_cooldown_seconds": 10 }
 *   MAP (multi-lock, current): keyed by lock id, same fields per entry
 *     minus lock_id (the key IS the lock id):
 *     { "front_deadbolt": { "trigger_door": "Front Door", ... },
 *       "side_deadbolt":  { "trigger_door": "Side Door", ... } }
 *
 * Configs migrate forward automatically (startup + config reload + PUT),
 * so a config written by an older build keeps working with zero operator
 * action, and older writers (the Visual Designer still PUTs the flat shape)
 * keep working against the first automated lock.
 */

// The complete set of scalar keys the legacy flat shape ever carried. A key
// from this list at the TOP level marks the object as flat (map entries are
// objects keyed by lock id, never these).
const FLAT_KEYS = Object.freeze([
  'lock_id', 'trigger_door', 'require_result', 'mirror_unlock', 'relock_cooldown_seconds',
]);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Lock-id keys that would pollute Object.prototype if ever used to index into
// a plain object; never valid lock ids, so drop them defensively.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeLockId(k) {
  return !UNSAFE_KEYS.has(k);
}

/** True when db carries any legacy flat key at the top level. */
function isFlatShape(db) {
  if (!isPlainObject(db)) return false;
  return Object.keys(db).some((k) => FLAT_KEYS.includes(k));
}

/**
 * Convert to the map shape. Returns { changed, rules }. A pure-map (or
 * absent) input passes through unchanged. The flat entry lands under its
 * own lock_id, else the first saved lock, else the historical default id.
 * Tolerates a MIXED object (a stale writer spreading the migrated map and
 * adding flat keys on top): map-shaped values are preserved as entries and
 * the flat fields merge into the target entry.
 */
function toMapShape(db, locks) {
  if (!isPlainObject(db) || !isFlatShape(db)) return { changed: false, rules: db };
  const flat = {};
  const map = {};
  for (const [k, v] of Object.entries(db)) {
    if (FLAT_KEYS.includes(k)) flat[k] = v;
    else if (isPlainObject(v) && isSafeLockId(k)) map[k] = v;
    // anything else (a stray scalar, or a prototype-polluting key) is dropped
  }
  const rest = Object.assign({}, flat);
  delete rest.lock_id;
  const targetId = flat.lock_id
    || Object.keys(map)[0]
    || Object.keys(locks || {})[0]
    || 'front_deadbolt';
  map[targetId] = Object.assign({}, map[targetId], rest);
  return { changed: true, rules: map };
}

/**
 * Normalize an incoming PUT /api/config deadbolt_rules payload BEFORE it is
 * merged: legacy/mixed writers keep working by having their flat fields
 * applied to the first automated lock (else the first saved lock).
 */
function normalizePutRules(incoming, existingMap, locks) {
  if (!isPlainObject(incoming) || !isFlatShape(incoming)) return incoming;
  const existingIds = automatedLockIds(existingMap);
  const seed = existingIds.length && !incoming.lock_id
    ? Object.assign({}, incoming, { lock_id: existingIds[0] })
    : incoming;
  return toMapShape(seed, locks).rules;
}

/** Lock ids that have an automation entry (map shape; flat resolves its one id). */
function automatedLockIds(db) {
  if (!isPlainObject(db)) return [];
  if (isFlatShape(db)) {
    return db.lock_id ? [db.lock_id] : [];
  }
  return Object.keys(db).filter((k) => isSafeLockId(k) && isPlainObject(db[k]));
}

/** The rules entry for one lock, shape-agnostic. Null when not automated. */
function rulesForLock(db, lockId) {
  if (!isPlainObject(db) || !lockId) return null;
  if (isFlatShape(db)) {
    const rest = Object.assign({}, db);
    delete rest.lock_id;
    // A flat block with no lock_id historically bound to the first lock;
    // the caller resolves that, so match any requested id in that case.
    return (!db.lock_id || db.lock_id === lockId) ? rest : null;
  }
  return isPlainObject(db[lockId]) ? db[lockId] : null;
}

module.exports = { FLAT_KEYS, isFlatShape, toMapShape, normalizePutRules, automatedLockIds, rulesForLock };
