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
