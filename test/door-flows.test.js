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
  migrateToTriggers,
  automatedLockIdsFromFlows,
  edgesForLock,
  cascadeRulesFromFlows,
  unlockRulesFromFlows,
  gatingDoorsForLock,
  backfillFlowDoorIds,
  validateFlows,
  legacyProjection,
  scopeMatches,
  triggersOf,
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

// ---------------------------------------------------------------------------
// migrateToTriggers: the door-flow spine migration (trigger shape)
// ---------------------------------------------------------------------------

test('migrateToTriggers: a flat door_flows becomes one everyone entry trigger', () => {
  const { flows } = migrateToFlows({
    deadbolt_rules: { l1: { trigger_door: 'Front Door', trigger_door_id: 'd-f' } },
    cascade_rules: { rules: [{ trigger_door: 'Front Door', unlock: ['Interior'], debounce_seconds: 8 }] },
  }, {});
  const out = migrateToTriggers({ door_flows: flows }, {});
  assert.equal(out.changed, true, 'a flat flow upgrade counts as changed');
  const trigs = out.flows['Front Door'].triggers;
  assert.equal(trigs.length, 1);
  assert.equal(trigs[0].type, 'entry');
  assert.equal(trigs[0].scope, null, 'everyone');
  assert.equal(trigs[0].actions.retract[0].lock_id, 'l1');
  assert.deepEqual(trigs[0].actions.unlock.doors, ['Interior']);
  assert.equal(trigs[0].actions.unlock.debounce_seconds, 8);
});

test('migrateToTriggers: unlock_rules become a group-scoped entry trigger on the trigger door', () => {
  const out = migrateToTriggers({
    unlock_rules: { rules: [{ group: 'Staff', trigger: 'Main Entrance', unlock: ['Elevator', 'Stairwell'], delay: 5 }] },
  }, {});
  const t = out.flows['Main Entrance'].triggers[0];
  assert.equal(t.type, 'entry');
  assert.deepEqual(t.scope, { groups: ['Staff'] });
  assert.deepEqual(t.actions.unlock.doors, ['Elevator', 'Stairwell']);
  assert.equal(t.actions.unlock.delay_seconds, 5);
});

test('migrateToTriggers: two unlock_rules on one door+group union unlock lists and keep one (max) delay', () => {
  const out = migrateToTriggers({
    unlock_rules: { rules: [
      { group: 'Staff', trigger: 'Main', unlock: ['A'], delay: 0 },
      { group: 'Staff', trigger: 'Main', unlock: ['A', 'B'], delay: 7 },
    ] },
  }, {});
  const t = out.flows['Main'].triggers.filter((x) => x.scope && x.scope.groups);
  assert.equal(t.length, 1, 'merged into one trigger');
  assert.deepEqual(t[0].actions.unlock.doors, ['A', 'B']);
  assert.equal(t[0].actions.unlock.delay_seconds, 7);
});

test('migrateToTriggers: default_action becomes an any_group trigger (not everyone)', () => {
  const out = migrateToTriggers({
    unlock_rules: {
      rules: [{ group: 'Staff', trigger: 'Main', unlock: ['Elevator'] }],
      default_action: { unlock: ['Lobby'] },
    },
  }, {});
  const anyG = out.flows['Main'].triggers.find((t) => t.scope && t.scope.any_group);
  assert.ok(anyG, 'an any_group trigger exists on the candidate door');
  assert.deepEqual(anyG.actions.unlock.doors, ['Lobby']);
  // and the resolved-group vs unresolved semantics hold:
  assert.equal(scopeMatches(anyG.scope, 'Visitors'), true, 'any resolved group matches');
  assert.equal(scopeMatches(anyG.scope, null), false, 'an unresolved user is skipped');
});

test('migrateToTriggers: doorbell_rules become a doorbell trigger with reason + viewer map', () => {
  const out = migrateToTriggers({
    doorbell_rules: {
      rules: [{ group: 'Royal Palm', trigger: 'Front Gate', unlock: ['Lobby'] }],
      trigger_reason_code: 107,
      viewer_to_group: { 'RP Concierge': 'Royal Palm' },
    },
  }, {});
  const t = out.flows['Front Gate'].triggers[0];
  assert.equal(t.type, 'doorbell');
  assert.deepEqual(t.scope, { groups: ['Royal Palm'] });
  assert.equal(t.doorbell.reason_code, 107);
  assert.deepEqual(t.doorbell.viewer_to_group, { 'RP Concierge': 'Royal Palm' });
});

test('migrateToTriggers step 5: lock_default converts by the lock hardware state', () => {
  const flat = {
    'Front Door': { door_id: 'd-f', retract: [{ lock_id: 'lockOn', after_unlock: 'lock_default' }], cascade: null },
    'Side Door': { door_id: 'd-s', retract: [{ lock_id: 'lockOff', after_unlock: 'lock_default' }], cascade: null },
  };
  const locks = { lockOn: { auto_relock: true, auto_relock_seconds: 45 }, lockOff: { auto_relock: false } };
  const out = migrateToTriggers({ door_flows: flat }, locks);
  const on = out.flows['Front Door'].triggers[0].actions.retract[0];
  const off = out.flows['Side Door'].triggers[0].actions.retract[0];
  assert.equal(on.after_unlock, 'relock_after');
  assert.equal(on.relock_seconds, 45, 'timer from the saved lock entry');
  assert.equal(off.after_unlock, 'stay_unlocked', 'app owns relock when hardware relock was off');
  assert.ok(out.logs.some((l) => /relock_after 45s/.test(l)));
});

test('migrateToTriggers: lock_default with no hardware info defaults to stay_unlocked and 30s when on', () => {
  const out = migrateToTriggers({
    door_flows: { 'A': { retract: [{ lock_id: 'l', after_unlock: 'lock_default' }], cascade: null } },
  }, { l: { auto_relock: true } });
  assert.equal(out.flows['A'].triggers[0].actions.retract[0].relock_seconds, 30);
});

test('migrateToTriggers: idempotent on an already-migrated config', () => {
  const first = migrateToTriggers({
    unlock_rules: { rules: [{ group: 'Staff', trigger: 'Main', unlock: ['Elevator'] }] },
    door_flows: { 'Main': { door_id: 'd', retract: [{ lock_id: 'l1', after_unlock: 'stay_unlocked' }], cascade: null } },
  }, {});
  const second = migrateToTriggers({ door_flows: first.flows }, {});
  assert.equal(second.changed, false, 'nothing left to convert');
  assert.deepEqual(second.flows, first.flows);
});

test('migrateToTriggers: drops prototype-polluting door keys', () => {
  const cfg = JSON.parse('{"unlock_rules":{"rules":[{"group":"g","trigger":"__proto__","unlock":["X"]}]}}');
  const out = migrateToTriggers(cfg, {});
  assert.ok(!('__proto__' in out.flows) || !Object.prototype.hasOwnProperty.call(out.flows, '__proto__'));
});

// ---------------------------------------------------------------------------
// trigger-shape helpers
// ---------------------------------------------------------------------------

function triggerFlows() {
  return {
    'Main Entrance': {
      door_id: 'd-main',
      triggers: [
        { type: 'entry', scope: null, actions: { unlock: { doors: ['Interior'], debounce_seconds: 8, delay_seconds: 0 }, retract: [{ lock_id: 'lockM', after_unlock: 'stay_unlocked' }] } },
        { type: 'entry', scope: { groups: ['Staff'] }, actions: { unlock: { doors: ['Elevator'], debounce_seconds: 0, delay_seconds: 5 }, retract: [] } },
        { type: 'doorbell', scope: { groups: ['Staff'] }, doorbell: { reason_code: 107, viewer_to_group: {} }, actions: { unlock: { doors: ['Lobby'], debounce_seconds: 0, delay_seconds: 0 }, retract: [] } },
      ],
    },
  };
}

test('edgesForLock: carries trigger type + scope for the controller', () => {
  const edges = edgesForLock(triggerFlows(), 'lockM');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].type, 'entry');
  assert.equal(edges[0].scope, null);
  assert.equal(edges[0].after_unlock, 'stay_unlocked');
});

test('unlockRulesFromFlows: one scoped rule per unlock-bearing trigger, incl doorbell', () => {
  const rules = unlockRulesFromFlows(triggerFlows());
  assert.equal(rules.length, 3);
  const cascade = rules.find((r) => r.type === 'entry' && r.scope == null);
  assert.deepEqual(cascade.unlock, ['Interior']);
  assert.equal(cascade.debounce_seconds, 8);
  const scoped = rules.find((r) => r.type === 'entry' && r.scope && r.scope.groups);
  assert.equal(scoped.delay_seconds, 5);
  const bell = rules.find((r) => r.type === 'doorbell');
  assert.equal(bell.doorbell.reason_code, 107);
  assert.deepEqual(bell.unlock, ['Lobby']);
});

test('cascadeRulesFromFlows: only the everyone entry cascade, not scoped/doorbell unlocks', () => {
  const rules = cascadeRulesFromFlows(triggerFlows());
  assert.equal(rules.length, 1);
  assert.equal(rules[0].trigger_door, 'Main Entrance');
  assert.deepEqual(rules[0].unlock, ['Interior']);
});

test('gatingDoorsForLock over the trigger shape: the door that retracts the lock', () => {
  assert.deepEqual(gatingDoorsForLock(triggerFlows(), 'lockM'), [{ name: 'Main Entrance', id: 'd-main' }]);
});

test('scopeMatches: null=everyone, any_group=resolved only, groups=listed', () => {
  assert.equal(scopeMatches(null, null), true);
  assert.equal(scopeMatches(null, 'Anyone'), true);
  assert.equal(scopeMatches({ any_group: true }, 'Staff'), true);
  assert.equal(scopeMatches({ any_group: true }, null), false);
  assert.equal(scopeMatches({ groups: ['Staff'] }, 'staff'), true, 'case-insensitive');
  assert.equal(scopeMatches({ groups: ['Staff'] }, 'Visitors'), false);
  assert.equal(scopeMatches({ groups: ['Staff'] }, null), false);
});

test('legacyProjection: projects unlock_rules and doorbell_rules back from triggers', () => {
  const proj = legacyProjection(triggerFlows());
  assert.deepEqual(proj.unlock_rules.rules, [{ group: 'Staff', trigger: 'Main Entrance', unlock: ['Elevator'], delay: 5 }]);
  assert.equal(proj.doorbell_rules.rules[0].group, 'Staff');
  assert.equal(proj.doorbell_rules.rules[0].trigger, 'Main Entrance');
  assert.deepEqual(proj.doorbell_rules.rules[0].unlock, ['Lobby']);
  assert.deepEqual(proj.cascade_rules.rules[0].unlock, ['Interior']);
});

test('validateFlows: accepts the trigger shape and rejects a bad trigger', () => {
  assert.deepEqual(validateFlows(triggerFlows()), []);
  assert.ok(validateFlows({ 'A': { triggers: [{ type: 'nope', actions: {} }] } }).some((e) => /type must be one of/.test(e)));
  assert.ok(validateFlows({ 'A': { triggers: [{ type: 'entry', actions: { retract: [{ lock_id: 'l', after_unlock: 'relock_after' }] } }] } }).some((e) => /relock_seconds > 0/.test(e)));
  assert.ok(validateFlows({ 'A': { triggers: [{ type: 'entry', scope: { groups: [42] }, actions: {} }] } }).some((e) => /scope.groups must be an array/.test(e)));
});

test('triggersOf: a flat flow yields one everyone entry trigger; a trigger flow passes through', () => {
  const flat = triggersOf({ retract: [{ lock_id: 'l' }], cascade: { unlock: ['X'], debounce_seconds: 8 } });
  assert.equal(flat.length, 1);
  assert.equal(flat[0].type, 'entry');
  assert.equal(flat[0].scope, null);
  assert.equal(triggersOf(triggerFlows()['Main Entrance']).length, 3);
});
