'use strict';

// End-to-end guard for the door-flow spine: a v10.0.0-style config (flat
// door_flows + unlock_rules + doorbell_rules) migrates to the trigger shape and
// drives the SAME runtime behavior through the deadbolt controller, plus the
// new scope + doorbell coverage. This is the before/after fixture the migration
// invariant (section 5 / acceptance A + B) demands.

const test = require('node:test');
const assert = require('node:assert');

const doorFlows = require('../src/door-flows');
const DeadboltController = require('../src/deadbolt-controller');
const FakeLock = require('../src/drivers/fake-lock');
const { LockState } = require('../src/drivers/lock-driver');

const flush = () => new Promise((r) => setTimeout(r, 10));

function entryGrant(door, { actorId, actor = 'User', result = 'ACCESS', doorId = 'd-main' } = {}) {
  return {
    event: 'access.logs.add',
    data: {
      _source: {
        target: [{ type: 'door', id: doorId, display_name: door }],
        actor: { id: actorId || null, display_name: actor },
        event: { type: 'access.door.unlock', result },
        authentication: { credential_provider: 'NFC' },
      },
    },
  };
}

function doorbell(door, { reason = 107, actorId, doorId = 'd-main' } = {}) {
  return {
    event: 'access.doorbell.completed',
    data: { object: { reason_code: reason }, location: { name: door, id: doorId }, actor: { id: actorId || null } },
  };
}

// A representative v10.0.0 config: one deadbolt retract + one cascade on Main
// Entrance, a Staff group unlock, and a doorbell rule.
function v10Config() {
  return {
    devices: { zwave: { locks: { front_deadbolt: { node_id: 3, auto_relock: false } } } },
    door_flows: {
      'Main Entrance': {
        door_id: 'd-main',
        retract: [{ lock_id: 'front_deadbolt', after_unlock: 'lock_default', require_result: 'ACCESS', mirror_unlock: false, relock_cooldown_seconds: 10 }],
        cascade: { unlock: ['Interior Door'], debounce_seconds: 8 },
      },
    },
    unlock_rules: { rules: [{ group: 'Staff', trigger: 'Main Entrance', unlock: ['Elevator'], delay: 0 }], default_action: { unlock: [] } },
    doorbell_rules: { rules: [{ group: 'Staff', trigger: 'Main Entrance', unlock: ['Lobby'] }], trigger_reason_code: 107, viewer_to_group: {}, default_action: { unlock: [] } },
  };
}

function buildControllers(flows, groups) {
  const lock = new FakeLock({ initial: LockState.LOCKED });
  const unifi = { calls: [], async unlockDoorByName(name) { this.calls.push(name); return { success: true, door: name }; } };
  const clock = { t: 0 };
  const deps = {
    unifiClient: unifi,
    logger: { debug() {}, info() {}, warn() {} },
    now: () => clock.t,
    resolveGroup: ({ actorId }) => groups[actorId] || null,
  };
  const lockCtl = new DeadboltController(
    { edges: doorFlows.edgesForLock(flows, 'front_deadbolt'), cascade_rules: { rules: [] } },
    Object.assign({ lockDriver: lock }, deps)
  );
  const unlockCtl = new DeadboltController(
    { deadbolt_rules: undefined, cascade_rules: { rules: doorFlows.unlockRulesFromFlows(flows) } },
    Object.assign({ lockDriver: null }, deps)
  );
  const feed = (raw) => { lockCtl.observe(raw); unlockCtl.observe(raw); };
  // Advance past the cascade debounce window between distinct badges.
  const advance = () => { clock.t += 60000; };
  return { lock, unifi, feed, clock, advance, destroy: () => { lockCtl.destroy(); unlockCtl.destroy(); } };
}

test('migration invariance: a v10 config keeps the same entry behavior (retract + cascade)', async () => {
  const cfg = v10Config();
  const { flows, changed } = doorFlows.migrateToTriggers(cfg, cfg.devices.zwave.locks);
  assert.equal(changed, true);
  // lock_default converted to stay_unlocked (hardware auto-relock was off).
  const edge = doorFlows.edgesForLock(flows, 'front_deadbolt')[0];
  assert.equal(edge.after_unlock, 'stay_unlocked');

  const { lock, unifi, feed, destroy } = buildControllers(flows, { 'u-staff': 'Staff', 'u-anon': null });
  await lock.init();
  // Any user (everyone cascade + retract) at Main Entrance: bolt retracts, Interior cascades.
  feed(entryGrant('Main Entrance', { actorId: 'u-anon' }));
  await flush();
  assert.equal(lock.calls.filter((c) => c.action === 'unlock').length, 1, 'deadbolt retracted for everyone');
  assert.deepEqual(unifi.calls, ['Interior Door'], 'everyone cascade fired');
  destroy();
});

test('migration: a Staff badge also gets the group unlock; a visitor does not', async () => {
  const cfg = v10Config();
  const { flows } = doorFlows.migrateToTriggers(cfg, cfg.devices.zwave.locks);
  const { unifi, feed, lock, advance, destroy } = buildControllers(flows, { 'u-staff': 'Staff', 'u-visitor': 'Visitors' });
  await lock.init();
  feed(entryGrant('Main Entrance', { actorId: 'u-staff' }));
  await flush();
  assert.deepEqual(unifi.calls.sort(), ['Elevator', 'Interior Door'], 'staff gets cascade + group unlock');
  unifi.calls.length = 0;
  advance(); // past the cascade debounce
  feed(entryGrant('Main Entrance', { actorId: 'u-visitor' }));
  await flush();
  assert.deepEqual(unifi.calls, ['Interior Door'], 'a visitor gets only the everyone cascade, not the Staff unlock');
  destroy();
});

test('migration: the doorbell rule fires only on a doorbell, only for Staff', async () => {
  const cfg = v10Config();
  const { flows } = doorFlows.migrateToTriggers(cfg, cfg.devices.zwave.locks);
  const { unifi, feed, lock, destroy } = buildControllers(flows, { 'u-staff': 'Staff', 'u-visitor': 'Visitors' });
  await lock.init();
  // An entry grant must NOT fire the doorbell unlock.
  feed(entryGrant('Main Entrance', { actorId: 'u-staff' }));
  await flush();
  assert.ok(!unifi.calls.includes('Lobby'), 'entry does not fire the doorbell unlock');
  unifi.calls.length = 0;
  // A Staff-answered doorbell fires it.
  feed(doorbell('Main Entrance', { actorId: 'u-staff' }));
  await flush();
  assert.deepEqual(unifi.calls, ['Lobby']);
  unifi.calls.length = 0;
  // A visitor-answered doorbell does not.
  feed(doorbell('Main Entrance', { actorId: 'u-visitor' }));
  await flush();
  assert.deepEqual(unifi.calls, []);
  destroy();
});

test('migration: default_action becomes an any_group unlock (resolved gets it, unresolved does not)', async () => {
  const cfg = v10Config();
  cfg.unlock_rules.default_action = { unlock: ['Garage'] };
  const { flows } = doorFlows.migrateToTriggers(cfg, cfg.devices.zwave.locks);
  const { unifi, feed, lock, destroy } = buildControllers(flows, { 'u-any': 'AnyMappedGroup', 'u-none': null });
  await lock.init();
  feed(entryGrant('Main Entrance', { actorId: 'u-any' }));
  await flush();
  assert.ok(unifi.calls.includes('Garage'), 'a resolved (but unmapped-rule) group still gets the default unlocks');
  unifi.calls.length = 0;
  feed(entryGrant('Main Entrance', { actorId: 'u-none' }));
  await flush();
  assert.ok(!unifi.calls.includes('Garage'), 'an unresolvable user gets nothing from any_group');
  destroy();
});

test('migration: default_action is a FALLBACK, not additive (a group with its own rule does not also get the default)', async () => {
  // Old rules-engine treated default_action as an else-if: a Staff tap at Main
  // unlocked only Elevator, never the default. The migration must preserve that.
  const cfg = v10Config();
  cfg.unlock_rules = { rules: [{ group: 'Staff', trigger: 'Main Entrance', unlock: ['Elevator'] }], default_action: { unlock: ['Lobby'] } };
  cfg.doorbell_rules = { rules: [], trigger_reason_code: 107, viewer_to_group: {}, default_action: { unlock: [] } };
  const { flows } = doorFlows.migrateToTriggers(cfg, cfg.devices.zwave.locks);
  const { unifi, feed, lock, advance, destroy } = buildControllers(flows, { 'u-staff': 'Staff', 'u-visitor': 'Visitors' });
  await lock.init();
  // Staff HAS a rule at Main -> gets ONLY Elevator, not the default Lobby.
  feed(entryGrant('Main Entrance', { actorId: 'u-staff' }));
  await flush();
  assert.ok(unifi.calls.includes('Elevator'), 'staff gets its own rule');
  assert.ok(!unifi.calls.includes('Lobby'), 'staff does NOT also get the default (fallback, not additive)');
  unifi.calls.length = 0;
  advance();
  // A resolved group with NO rule at Main falls back to the default Lobby.
  feed(entryGrant('Main Entrance', { actorId: 'u-visitor' }));
  await flush();
  assert.ok(unifi.calls.includes('Lobby'), 'a resolved group with no rule gets the default');
  assert.ok(!unifi.calls.includes('Elevator'), 'and not the Staff-only door');
  destroy();
});

test('migration: an array unlock_rule with no trigger stays a dead rule (no trigger_location graft)', () => {
  // The old engine returned array rules verbatim; a rule with no `trigger`
  // never matched. A leftover trigger_location must NOT resurrect it.
  const out = doorFlows.migrateToTriggers({
    unlock_rules: { trigger_location: 'Main', rules: [{ group: 'Staff', unlock: ['Elevator'] }] },
  }, {});
  assert.deepEqual(Object.keys(out.flows), [], 'the triggerless rule produced no flow');
});

test('migration is PURE: it never mutates the input config edges', () => {
  const input = { door_flows: { 'A': { door_id: null, triggers: [{ type: 'entry', scope: null, actions: { unlock: null, retract: [{ lock_id: 'l', after_unlock: 'lock_default' }] } }] } } };
  const before = JSON.stringify(input);
  doorFlows.migrateToTriggers(input, { l: { auto_relock: true, auto_relock_seconds: 60 } });
  assert.equal(JSON.stringify(input), before, 'the caller config is untouched (no shared-ref mutation)');
});

test('migration: lock_default converts to relock_after when the lock hardware auto-relock was on', () => {
  const cfg = v10Config();
  cfg.devices.zwave.locks.front_deadbolt.auto_relock = true;
  cfg.devices.zwave.locks.front_deadbolt.auto_relock_seconds = 30;
  const { flows } = doorFlows.migrateToTriggers(cfg, cfg.devices.zwave.locks);
  const edge = doorFlows.edgesForLock(flows, 'front_deadbolt')[0];
  assert.equal(edge.after_unlock, 'relock_after');
  assert.equal(edge.relock_seconds, 30);
});

test('gating regression: gating doors are unchanged by the trigger migration', () => {
  const cfg = v10Config();
  const { flows } = doorFlows.migrateToTriggers(cfg, cfg.devices.zwave.locks);
  assert.deepEqual(doorFlows.gatingDoorsForLock(flows, 'front_deadbolt'), [{ name: 'Main Entrance', id: 'd-main' }]);
});

test('legacy projection round-trips the migrated config for external readers', () => {
  const cfg = v10Config();
  const { flows } = doorFlows.migrateToTriggers(cfg, cfg.devices.zwave.locks);
  const proj = doorFlows.legacyProjection(flows);
  assert.equal(proj.deadbolt_rules.front_deadbolt.trigger_door, 'Main Entrance');
  assert.deepEqual(proj.cascade_rules.rules[0].unlock, ['Interior Door']);
  assert.deepEqual(proj.unlock_rules.rules[0], { group: 'Staff', trigger: 'Main Entrance', unlock: ['Elevator'], delay: 0 });
  assert.equal(proj.doorbell_rules.rules[0].group, 'Staff');
  assert.deepEqual(proj.doorbell_rules.rules[0].unlock, ['Lobby']);
});
