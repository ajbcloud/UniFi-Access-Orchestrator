'use strict';

// Guards src/door-flows.js: the door-centric automation shape and its
// migration from {deadbolt_rules, cascade_rules}. The #1 invariant under
// test: a migrated single-door/single-deadbolt config behaves IDENTICALLY
// to today - after_unlock defaults to 'lock_default' (the app schedules
// nothing) and every advanced field carries over with its legacy default.

const test = require('node:test');
const assert = require('node:assert');
const {
  migrateToFlows,
  automatedLockIdsFromFlows,
  edgesForLock,
  cascadeRulesFromFlows,
  gatingDoorsForLock,
  backfillFlowDoorIds,
  validateFlows,
  legacyProjection,
} = require('../src/door-flows');

// ---------------------------------------------------------------------------
// migrateToFlows
// ---------------------------------------------------------------------------

test('HARD CASE: single-lock + single-cascade legacy migrates field-for-field', () => {
  const cfg = {
    deadbolt_rules: {
      front_deadbolt: {
        trigger_door: 'Front Door',
        trigger_door_id: 'd-front',
        require_result: 'ACCESS',
        mirror_unlock: false,
        relock_cooldown_seconds: 10,
      },
    },
    cascade_rules: { rules: [{ trigger_door: 'Front Door', unlock: ['Interior Door'], debounce_seconds: 8 }] },
  };
  const { changed, flows } = migrateToFlows(cfg, { front_deadbolt: {} });
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(flows), ['Front Door']);
  assert.equal(flows['Front Door'].door_id, 'd-front', 'trigger_door_id carried as door_id');
  assert.deepEqual(flows['Front Door'].retract, [{
    lock_id: 'front_deadbolt',
    after_unlock: 'lock_default', // THE invariant: app schedules nothing
    require_result: 'ACCESS',
    mirror_unlock: false,
    relock_cooldown_seconds: 10,
  }]);
  assert.deepEqual(flows['Front Door'].cascade, { unlock: ['Interior Door'], debounce_seconds: 8 });
});

test('legacy defaults are filled exactly (require_result ACCESS, cooldown 10, debounce 8)', () => {
  const cfg = {
    deadbolt_rules: { l1: { trigger_door: 'Door A' } },
    cascade_rules: { rules: [{ trigger_door: 'Door A', unlock: ['Door B'] }] },
  };
  const { flows } = migrateToFlows(cfg, {});
  const edge = flows['Door A'].retract[0];
  assert.equal(edge.require_result, 'ACCESS');
  assert.equal(edge.mirror_unlock, false);
  assert.equal(edge.relock_cooldown_seconds, 10);
  assert.equal(flows['Door A'].cascade.debounce_seconds, 8);
});

test('legacy FLAT deadbolt_rules migrates (delegates to toMapShape)', () => {
  const cfg = { deadbolt_rules: { lock_id: 'front', trigger_door: 'Main Entry', mirror_unlock: true } };
  const { flows } = migrateToFlows(cfg, {});
  assert.deepEqual(Object.keys(flows), ['Main Entry']);
  assert.equal(flows['Main Entry'].retract[0].lock_id, 'front');
  assert.equal(flows['Main Entry'].retract[0].mirror_unlock, true);
});

test('cleared trigger ("") and lock_id-only entries produce NO edge (manual-only)', () => {
  const cfg = { deadbolt_rules: { a: { trigger_door: '' }, b: {}, c: { trigger_door: '   ' } } };
  const { flows } = migrateToFlows(cfg, {});
  assert.deepEqual(flows, {}, 'no door key at all');
});

test('two locks on two doors -> two door keys, one edge each', () => {
  const cfg = { deadbolt_rules: {
    l1: { trigger_door: 'Door A' },
    l2: { trigger_door: 'Door B' },
  } };
  const { flows } = migrateToFlows(cfg, {});
  assert.equal(flows['Door A'].retract.length, 1);
  assert.equal(flows['Door B'].retract.length, 1);
});

test('two locks on the SAME door -> one door key, two edges', () => {
  const cfg = { deadbolt_rules: {
    l1: { trigger_door: 'Door A' },
    l2: { trigger_door: 'Door A' },
  } };
  const { flows } = migrateToFlows(cfg, {});
  assert.equal(Object.keys(flows).length, 1);
  assert.deepEqual(flows['Door A'].retract.map((e) => e.lock_id).sort(), ['l1', 'l2']);
});

test('two cascade rules on ONE door union unlock lists, take min debounce, flag merged', () => {
  const cfg = { cascade_rules: { rules: [
    { trigger_door: 'Door A', unlock: ['Door B'], debounce_seconds: 8 },
    { trigger_door: 'Door A', unlock: ['Door B', 'Elevator'], debounce_seconds: 3 },
  ] } };
  const { flows } = migrateToFlows(cfg, {});
  assert.deepEqual(flows['Door A'].cascade.unlock, ['Door B', 'Elevator']);
  assert.equal(flows['Door A'].cascade.debounce_seconds, 3);
  assert.equal(flows['Door A'].cascade.merged, true, 'signal for the migration log');
});

test('empty inputs -> {}; door_flows already present -> authoritative passthrough', () => {
  assert.deepEqual(migrateToFlows({}, {}), { changed: false, flows: {} });
  assert.deepEqual(migrateToFlows(null, {}), { changed: false, flows: {} });
  const existing = { 'Door A': { door_id: null, retract: [], cascade: null } };
  const out = migrateToFlows({ door_flows: existing, deadbolt_rules: { l1: { trigger_door: 'X' } } }, {});
  assert.equal(out.changed, false);
  assert.equal(out.flows, existing, 'door_flows wins over stale legacy keys');
});

test('re-running migration on a migrated config is a no-op (idempotent)', () => {
  const cfg = { deadbolt_rules: { l1: { trigger_door: 'Door A' } } };
  const first = migrateToFlows(cfg, {});
  const second = migrateToFlows({ door_flows: first.flows }, {});
  assert.equal(second.changed, false);
  assert.deepEqual(second.flows, first.flows);
});

test('prototype-polluting keys are dropped', () => {
  const db = JSON.parse('{"__proto__": {"trigger_door": "Evil Door"}, "ok": {"trigger_door": "Door A"}}');
  const { flows } = migrateToFlows({ deadbolt_rules: db }, {});
  assert.deepEqual(Object.keys(flows), ['Door A']);
  assert.ok(!('Evil Door' in flows));
});

// ---------------------------------------------------------------------------
// reverse-index helpers
// ---------------------------------------------------------------------------

function twoDoorFlows() {
  return {
    'Door A': {
      door_id: 'd-a',
      retract: [
        { lock_id: 'l1', after_unlock: 'relock_after', relock_seconds: 30, require_result: 'ACCESS', mirror_unlock: false, relock_cooldown_seconds: 10 },
        { lock_id: 'l2', after_unlock: 'lock_default', require_result: 'ACCESS', mirror_unlock: true, relock_cooldown_seconds: 5 },
      ],
      cascade: { unlock: ['Elevator'], debounce_seconds: 8 },
    },
    'Door B': {
      door_id: null,
      retract: [{ lock_id: 'l1', after_unlock: 'stay_unlocked', require_result: 'ACCESS', mirror_unlock: false, relock_cooldown_seconds: 10 }],
      cascade: null,
    },
  };
}

test('automatedLockIdsFromFlows: unique ids in first-appearance order', () => {
  assert.deepEqual(automatedLockIdsFromFlows(twoDoorFlows()), ['l1', 'l2']);
  assert.deepEqual(automatedLockIdsFromFlows({}), []);
  assert.deepEqual(automatedLockIdsFromFlows(null), []);
});

test('edgesForLock: a lock referenced by multiple doors gets one edge per door', () => {
  const edges = edgesForLock(twoDoorFlows(), 'l1');
  assert.equal(edges.length, 2);
  const byDoor = Object.fromEntries(edges.map((e) => [e.trigger_door, e]));
  assert.equal(byDoor['Door A'].after_unlock, 'relock_after');
  assert.equal(byDoor['Door A'].relock_seconds, 30);
  assert.equal(byDoor['Door A'].trigger_door_id, 'd-a');
  assert.equal(byDoor['Door B'].after_unlock, 'stay_unlocked');
  assert.equal(byDoor['Door B'].trigger_door_id, null);
});

test('edgesForLock: unknown after_unlock coerces to lock_default (defensive)', () => {
  const flows = { 'Door A': { retract: [{ lock_id: 'l1', after_unlock: 'explode' }] } };
  assert.equal(edgesForLock(flows, 'l1')[0].after_unlock, 'lock_default');
});

test('cascadeRulesFromFlows: exact legacy controller shape; doors without cascade skipped', () => {
  const rules = cascadeRulesFromFlows(twoDoorFlows());
  assert.deepEqual(rules, [{
    trigger_door: 'Door A', trigger_door_id: 'd-a', unlock: ['Elevator'], debounce_seconds: 8,
  }]);
});

test('gatingDoorsForLock: name+id pairs; empty for an untriggered lock (ungated)', () => {
  assert.deepEqual(gatingDoorsForLock(twoDoorFlows(), 'l2'), [{ name: 'Door A', id: 'd-a' }]);
  assert.deepEqual(gatingDoorsForLock(twoDoorFlows(), 'l1').map((d) => d.name).sort(), ['Door A', 'Door B']);
  assert.deepEqual(gatingDoorsForLock(twoDoorFlows(), 'nope'), []);
});

// ---------------------------------------------------------------------------
// backfillFlowDoorIds
// ---------------------------------------------------------------------------

test('backfill: resolves missing door_id by (case-insensitive) name', () => {
  const flows = { 'front door': { door_id: null, retract: [], cascade: null } };
  const changed = backfillFlowDoorIds(flows, new Map([['Front Door', 'd-1']]), new Map([['d-1', 'Front Door']]));
  assert.equal(changed, true);
  assert.equal(flows['front door'].door_id, 'd-1');
});

test('backfill: re-keys a flow when the stored id survives a rename', () => {
  const flows = { 'Old Name': { door_id: 'd-1', retract: [], cascade: null } };
  const changed = backfillFlowDoorIds(flows, new Map([['New Name', 'd-1']]), new Map([['d-1', 'New Name']]));
  assert.equal(changed, true);
  assert.ok(flows['New Name'], 'flow moved under the live display name');
  assert.ok(!flows['Old Name']);
});

test('backfill: cascade unlock targets get parallel ids and rename-refreshed names', () => {
  const flows = {
    'Door A': { door_id: 'd-a', retract: [], cascade: { unlock: ['Elevator'], debounce_seconds: 8 } },
  };
  backfillFlowDoorIds(flows, new Map([['Door A', 'd-a'], ['Elevator', 'd-e']]), new Map([['d-a', 'Door A'], ['d-e', 'Elevator']]));
  assert.deepEqual(flows['Door A'].cascade.unlock_ids, ['d-e']);
  // Now rename Elevator -> Lift in the registry; display name refreshes.
  backfillFlowDoorIds(flows, new Map([['Door A', 'd-a'], ['Lift', 'd-e']]), new Map([['d-a', 'Door A'], ['d-e', 'Lift']]));
  assert.deepEqual(flows['Door A'].cascade.unlock, ['Lift']);
});

test('backfill: no registry match leaves the flow untouched (fail open elsewhere)', () => {
  const flows = { 'Ghost Door': { door_id: null, retract: [], cascade: null } };
  const changed = backfillFlowDoorIds(flows, new Map(), new Map());
  assert.equal(changed, false);
  assert.equal(flows['Ghost Door'].door_id, null);
});

// ---------------------------------------------------------------------------
// validateFlows
// ---------------------------------------------------------------------------

test('validateFlows: accepts a well-formed flows object', () => {
  assert.deepEqual(validateFlows(twoDoorFlows()), []);
  assert.deepEqual(validateFlows({}), []);
});

test('validateFlows: rejects bad shapes with specific messages', () => {
  assert.ok(validateFlows(null).length, 'non-object rejected');
  assert.ok(validateFlows({ 'Door A': { retract: [{}] } })
    .some((e) => /without a lock_id/.test(e)));
  assert.ok(validateFlows({ 'Door A': { retract: [{ lock_id: 'l1', after_unlock: 'never' }] } })
    .some((e) => /after_unlock must be one of/.test(e)));
  assert.ok(validateFlows({ 'Door A': { retract: [{ lock_id: 'l1', after_unlock: 'relock_after' }] } })
    .some((e) => /relock_seconds > 0/.test(e)));
  assert.ok(validateFlows({ 'Door A': { retract: [{ lock_id: 'l1' }, { lock_id: 'l1' }] } })
    .some((e) => /more than once/.test(e)));
  assert.ok(validateFlows({ 'Door A': { cascade: { unlock: [42] } } })
    .some((e) => /unlock must be an array of door names/.test(e)));
});

// ---------------------------------------------------------------------------
// legacyProjection
// ---------------------------------------------------------------------------

test('legacyProjection: round-trips a single-door config to the old shapes', () => {
  const cfg = {
    deadbolt_rules: { front: { trigger_door: 'Front Door', trigger_door_id: 'd-f', require_result: 'ACCESS', mirror_unlock: false, relock_cooldown_seconds: 10 } },
    cascade_rules: { rules: [{ trigger_door: 'Front Door', unlock: ['Interior'], debounce_seconds: 8 }] },
  };
  const { flows } = migrateToFlows(cfg, {});
  const proj = legacyProjection(flows);
  assert.equal(proj.deadbolt_rules.front.trigger_door, 'Front Door');
  assert.equal(proj.deadbolt_rules.front.trigger_door_id, 'd-f');
  assert.equal(proj.deadbolt_rules.front.relock_cooldown_seconds, 10);
  assert.equal(proj.cascade_rules.rules[0].unlock[0], 'Interior');
});

test('legacyProjection: multi-door lock projects its FIRST edge (legacy cannot express more)', () => {
  const proj = legacyProjection(twoDoorFlows());
  assert.equal(proj.deadbolt_rules.l1.trigger_door, 'Door A');
  assert.equal(proj.deadbolt_rules.l2.trigger_door, 'Door A');
});
