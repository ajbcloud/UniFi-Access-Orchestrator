'use strict';

// Guards src/lock-cleanup.js: unpairing must delete the lock's config entry
// AND its automation rule (a zeroed entry used to linger as an un-actionable
// "not paired" ghost in the UI), and the startup prune must remove ONLY
// entries an old unpair zeroed (node_id === 0 strictly) - never a dev-mode
// FakeLock binding or hand-written entry that simply has no node_id.

const test = require('node:test');
const assert = require('node:assert');
const { removeLockEntry, pruneGhostLocks } = require('../src/lock-cleanup');

function cfgWith(locks, rules) {
  return {
    devices: { zwave: { serial_path: 'COM3', enabled: true, locks } },
    deadbolt_rules: rules,
  };
}

test('removeLockEntry deletes the lock entry AND its deadbolt_rules key', () => {
  const cfg = cfgWith(
    { front: { node_id: 14, user_codes: { 1: { user_id: 'u1', pin_code: '1234' } } }, side: { node_id: 15 } },
    { front: { trigger_door: 'Door A' }, side: { trigger_door: 'Door B' } }
  );
  assert.equal(removeLockEntry(cfg, 'front'), true);
  assert.ok(!('front' in cfg.devices.zwave.locks), 'lock entry gone');
  assert.ok(!('front' in cfg.deadbolt_rules), 'automation rule gone');
  assert.ok(cfg.devices.zwave.locks.side, 'other locks untouched');
  assert.deepEqual(cfg.deadbolt_rules.side, { trigger_door: 'Door B' }, 'other rules untouched');
});

test('removeLockEntry handles a rule-only or lock-only presence', () => {
  const ruleOnly = cfgWith({}, { ghost: { trigger_door: 'Door A' } });
  assert.equal(removeLockEntry(ruleOnly, 'ghost'), true);
  assert.ok(!('ghost' in ruleOnly.deadbolt_rules));
  const lockOnly = cfgWith({ ghost: { node_id: 0 } }, {});
  assert.equal(removeLockEntry(lockOnly, 'ghost'), true);
  assert.ok(!('ghost' in lockOnly.devices.zwave.locks));
});

test('removeLockEntry is safe on missing shapes and unknown ids', () => {
  assert.equal(removeLockEntry(null, 'x'), false);
  assert.equal(removeLockEntry({}, 'x'), false);
  assert.equal(removeLockEntry(cfgWith({}, {}), 'nope'), false);
  assert.equal(removeLockEntry(cfgWith({ a: { node_id: 1 } }, undefined), 'nope'), false);
});

test('pruneGhostLocks removes node_id 0 entries with their rules and reports them', () => {
  const cfg = cfgWith(
    {
      ghost: { node_id: 0, user_codes: {} },
      live: { node_id: 15 },
    },
    { ghost: { trigger_door: 'Door 29d3' }, live: { trigger_door: 'Door B' } }
  );
  assert.deepEqual(pruneGhostLocks(cfg), ['ghost']);
  assert.ok(!('ghost' in cfg.devices.zwave.locks));
  assert.ok(!('ghost' in cfg.deadbolt_rules));
  assert.ok(cfg.devices.zwave.locks.live);
  assert.ok(cfg.deadbolt_rules.live);
});

test('pruneGhostLocks is STRICT: entries without a node_id are never pruned', () => {
  const cfg = cfgWith(
    {
      fake_dev: { name: 'Dev FakeLock' }, // no node_id at all
      nullish: { node_id: null },
      ghost: { node_id: 0 },
    },
    {}
  );
  assert.deepEqual(pruneGhostLocks(cfg), ['ghost']);
  assert.ok(cfg.devices.zwave.locks.fake_dev, 'node_id-less entry survives');
  assert.ok(cfg.devices.zwave.locks.nullish, 'node_id null survives (only 0 is the legacy unpair marker)');
});

test('pruneGhostLocks tolerates empty configs', () => {
  assert.deepEqual(pruneGhostLocks(null), []);
  assert.deepEqual(pruneGhostLocks({}), []);
  assert.deepEqual(pruneGhostLocks(cfgWith({}, {})), []);
});

// ---------------------------------------------------------------------------
// removeLockEntry also cleans the CURRENT trigger-shaped door_flows (round 2).
// The old code only understood the legacy flat flow.retract, so removing a lock
// left dangling triggers[].actions.retract edges pointing at a lock that no
// longer exists (which then skewed the active-lock resolution to a ghost id).
// ---------------------------------------------------------------------------

test('removeLockEntry strips trigger-shaped retract edges for the removed lock', () => {
  const cfg = {
    devices: { zwave: { locks: {
      front_deadbolt: { node_id: 18, user_codes: { 1: { user_id: 'u1', pin_code: '1111' } } },
      back_deadbolt: { node_id: 19, user_codes: {} },
    } } },
    door_flows: {
      'Front Door': { door_id: 'd1', triggers: [
        { type: 'entry', scope: null, actions: {
          unlock: [{ doors: ['Inner'], delay_seconds: 0 }],
          retract: [{ lock_id: 'front_deadbolt', after_unlock: 'relock' }, { lock_id: 'back_deadbolt', after_unlock: 'relock' }],
        } },
      ] },
      'Garage Door': { door_id: 'd2', triggers: [
        { type: 'entry', scope: null, actions: { unlock: [], retract: [{ lock_id: 'front_deadbolt' }] } },
      ] },
    },
  };
  const removed = removeLockEntry(cfg, 'front_deadbolt');
  assert.strictEqual(removed, true);
  // the lock entry (and its user_codes) is gone
  assert.ok(!cfg.devices.zwave.locks.front_deadbolt, 'lock entry deleted');
  assert.ok(cfg.devices.zwave.locks.back_deadbolt, 'the other lock survives');
  // Front Door keeps its trigger (still unlocks + retracts back_deadbolt), but the
  // front_deadbolt edge is gone.
  const frontRetract = cfg.door_flows['Front Door'].triggers[0].actions.retract;
  assert.deepStrictEqual(frontRetract.map((e) => e.lock_id), ['back_deadbolt'], 'only the removed lock edge is stripped');
  assert.strictEqual(cfg.door_flows['Front Door'].triggers[0].actions.unlock.length, 1, 'unrelated unlock preserved');
  // Garage Door's only trigger retracted just the removed lock and had no unlock,
  // so the now-empty trigger is dropped and the door with it.
  assert.ok(!cfg.door_flows['Garage Door'], 'a door left with no live trigger is dropped');
});

test('removeLockEntry keeps an unlock-only trigger that never referenced the lock', () => {
  const cfg = {
    devices: { zwave: { locks: { gone: { node_id: 5 } } } },
    door_flows: { 'Lobby': { triggers: [
      { type: 'entry', scope: null, actions: { unlock: [{ doors: ['Elevator'] }], retract: [] } },
    ] } },
  };
  removeLockEntry(cfg, 'gone');
  assert.ok(cfg.door_flows['Lobby'], 'an unlock-only door is untouched by removing an unrelated lock');
  assert.strictEqual(cfg.door_flows['Lobby'].triggers.length, 1);
});
