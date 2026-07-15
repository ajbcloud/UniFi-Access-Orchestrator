'use strict';

// Guards the deadbolt_rules shape helpers: the legacy FLAT single-lock block
// must migrate to the per-lock MAP without operator action, legacy writers
// (the Visual Designer PUTs the flat shape) must keep working against the
// first automated lock, and mixed payloads (a stale writer spreading the
// migrated map and adding flat keys) must never corrupt the map.

const test = require('node:test');
const assert = require('node:assert');

const {
  isFlatShape, toMapShape, normalizePutRules, automatedLockIds, rulesForLock,
} = require('../src/deadbolt-rules');

const LOCKS = { front_deadbolt: { node_id: 14 }, side_deadbolt: { node_id: 17 } };

test('shape detection: flat vs map vs absent', () => {
  assert.equal(isFlatShape({ lock_id: 'front', trigger_door: 'Front Door' }), true);
  assert.equal(isFlatShape({ trigger_door: 'Front Door' }), true);
  assert.equal(isFlatShape({ front_deadbolt: { trigger_door: 'Front Door' } }), false);
  assert.equal(isFlatShape({}), false, 'an empty map is a map');
  assert.equal(isFlatShape(null), false);
  assert.equal(isFlatShape(undefined), false);
});

test('migration: full flat block lands under its own lock_id', () => {
  const flat = {
    lock_id: 'front_deadbolt', trigger_door: 'Front Door',
    require_result: 'ACCESS', mirror_unlock: false, relock_cooldown_seconds: 10,
  };
  const m = toMapShape(flat, LOCKS);
  assert.equal(m.changed, true);
  assert.deepEqual(m.rules, {
    front_deadbolt: {
      trigger_door: 'Front Door', require_result: 'ACCESS',
      mirror_unlock: false, relock_cooldown_seconds: 10,
    },
  });
});

test('migration: lock_id-only block (the fielded config) becomes an empty entry', () => {
  const m = toMapShape({ lock_id: 'front_deadbolt' }, LOCKS);
  assert.equal(m.changed, true);
  assert.deepEqual(m.rules, { front_deadbolt: {} });
});

test('migration: flat block with no lock_id targets the first saved lock', () => {
  const m = toMapShape({ trigger_door: 'Front Door' }, LOCKS);
  assert.deepEqual(Object.keys(m.rules), ['front_deadbolt']);
  assert.equal(m.rules.front_deadbolt.trigger_door, 'Front Door');
});

test('migration: map shape and absent pass through unchanged', () => {
  const map = { front_deadbolt: { trigger_door: 'Front Door' } };
  assert.equal(toMapShape(map, LOCKS).changed, false);
  assert.equal(toMapShape(map, LOCKS).rules, map);
  assert.equal(toMapShape(undefined, LOCKS).changed, false);
  assert.equal(toMapShape(null, LOCKS).changed, false);
});

test('migration: MIXED object (map spread + flat keys on top) preserves entries and merges flat fields', () => {
  const mixed = {
    front_deadbolt: { trigger_door: 'Front Door', relock_cooldown_seconds: 10 },
    side_deadbolt: { trigger_door: 'Side Door' },
    trigger_door: 'New Front Door', // the stale-writer spread pattern
  };
  const m = toMapShape(mixed, LOCKS);
  assert.equal(m.changed, true);
  assert.equal(m.rules.side_deadbolt.trigger_door, 'Side Door', 'other entries untouched');
  assert.equal(m.rules.front_deadbolt.trigger_door, 'New Front Door', 'flat field applied to the first entry');
  assert.equal(m.rules.front_deadbolt.relock_cooldown_seconds, 10, 'existing entry fields kept');
  assert.ok(!('trigger_door' in Object.fromEntries(Object.entries(m.rules).filter(([, v]) => typeof v !== 'object'))), 'no flat keys survive');
});

test('PUT normalization: a flat Designer write lands on the FIRST AUTOMATED lock, not the first saved', () => {
  const existing = { side_deadbolt: { trigger_door: 'Side Door' } }; // only side is automated
  const out = normalizePutRules({ trigger_door: 'New Side Door' }, existing, LOCKS);
  assert.deepEqual(Object.keys(out), ['side_deadbolt']);
  assert.equal(out.side_deadbolt.trigger_door, 'New Side Door');
});

test('PUT normalization: map payloads pass through untouched', () => {
  const map = { front_deadbolt: { trigger_door: 'Front Door' } };
  assert.equal(normalizePutRules(map, {}, LOCKS), map);
});

test('automatedLockIds handles both shapes', () => {
  assert.deepEqual(automatedLockIds({ a: { trigger_door: 'X' }, b: {} }), ['a', 'b']);
  assert.deepEqual(automatedLockIds({ lock_id: 'front', trigger_door: 'X' }), ['front']);
  assert.deepEqual(automatedLockIds({}), []);
  assert.deepEqual(automatedLockIds(null), []);
});

// Regression for the save-revert bug: when a FLAT config sits on disk (after
// a backup restore or hand-edit) and the dashboard PUTs a map-shaped update,
// the PUT handler migrates the merge TARGET first so the merge is map-into-map
// and the operator's new value survives the reload. This models that exact
// handler sequence (migrate current, then deep-merge, then the reload's
// toMapShape) end to end.
test('flat-on-disk + map PUT keeps the saved trigger through the merge+reload', () => {
  // deep-merge mirrors the PUT handler's deepMerge (plain-object recursive).
  const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const deepMerge = (t, s) => {
    if (!isPlain(s)) return s;
    if (!isPlain(t)) t = {};
    for (const k of Object.keys(s)) t[k] = isPlain(s[k]) ? deepMerge(t[k], s[k]) : s[k];
    return t;
  };

  // Flat config on disk (pre-migration), the fielded single-Schlage user.
  const current = { deadbolt_rules: { lock_id: 'front_deadbolt', trigger_door: 'Front Door', require_result: 'ACCESS' } };
  // F1 fix: migrate the merge target before merging.
  if (isFlatShape(current.deadbolt_rules)) {
    current.deadbolt_rules = toMapShape(current.deadbolt_rules, LOCKS).rules;
  }
  // Dashboard save changes the trigger (map-shaped, entry-scoped).
  const update = { front_deadbolt: { trigger_door: 'Side Door' } };
  current.deadbolt_rules = deepMerge(current.deadbolt_rules, update);
  // The subsequent reload runs toMapShape again; it must be a no-op passthrough.
  const reloaded = toMapShape(current.deadbolt_rules, LOCKS);
  assert.equal(reloaded.changed, false, 'already map-shaped after the fix');
  assert.equal(current.deadbolt_rules.front_deadbolt.trigger_door, 'Side Door', 'the save survives');
  assert.equal(current.deadbolt_rules.front_deadbolt.require_result, 'ACCESS', 'sibling fields preserved');
  assert.ok(!('trigger_door' in current.deadbolt_rules) && !('lock_id' in current.deadbolt_rules), 'no stale flat keys linger to revert it');
});

test('rulesForLock resolves per lock across both shapes', () => {
  const map = { a: { trigger_door: 'Door A' }, b: { trigger_door: 'Door B' } };
  assert.equal(rulesForLock(map, 'b').trigger_door, 'Door B');
  assert.equal(rulesForLock(map, 'zzz'), null);
  const flat = { lock_id: 'a', trigger_door: 'Door A' };
  assert.equal(rulesForLock(flat, 'a').trigger_door, 'Door A');
  assert.ok(!('lock_id' in rulesForLock(flat, 'a')), 'lock_id never leaks into an entry');
  assert.equal(rulesForLock(flat, 'b'), null);
});
